// Copyright 2024 Google LLC

// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// ARCore -> MediaPipe object detection bridge.
//
// This file contains TWO implementations selected by a scripting define:
//
//   MEDIAPIPE_TASKS NOT defined -> legacy CalculatorGraph path (plugin v0.12.0)
//   MEDIAPIPE_TASKS defined     -> MediaPipe Tasks API path (plugin v0.16.3+)
//
// Both expose the SAME public surface, so ARCursor.cs needs no change:
//   public UnityEvent<object, OutputEventArgs<List<Detection>>> callbackEvent
//   public bool MediaPipeDisabled
//   public bool renderMLCapture
//
// The Tasks path converts Tasks-API detections BACK into Mediapipe.Detection
// protos whose LocationData carries a NORMALISED RelativeBoundingBox. That is
// deliberate: ARCursor reads `Label[0]` and
// `LocationData.RelativeBoundingBox.Xmin/Ymin/Width/Height`, while the Tasks
// API reports boxes in PIXELS. The adapter is the bridge between the two.
//
// See XRObjects/MEDIAPIPE_UPGRADE.md for the upgrade procedure.

using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
using Stopwatch = System.Diagnostics.Stopwatch;

#if MEDIAPIPE_TASKS
using System.Collections.Concurrent;
using System.IO;
using Mediapipe;
using Mediapipe.Tasks.Core;
using Mediapipe.Tasks.Vision.Core;
using Mediapipe.Tasks.Vision.ObjectDetector;
using Mediapipe.Unity; // OutputEventArgs<T>
using TaskDetection = Mediapipe.Tasks.Components.Containers.Detection;
using TaskDetectionResult = Mediapipe.Tasks.Components.Containers.DetectionResult;
using MpImage = Mediapipe.Image;
using MpImageFormat = Mediapipe.ImageFormat;
#else
using Mediapipe;
using Mediapipe.Unity;
#endif

// Class for integrating ARCore and MediaPipe real-time object detection
// i.e., pass ARCore real-time frames to MediaPipe ML model
public class ARMPObjectDetection : MonoBehaviour
{
  [SerializeField] private ARCameraManager _cameraManager;

  [Tooltip("The UI RawImage used to display the image on screen.")]
  [SerializeField] private UnityEngine.UI.RawImage _rawImage;

  [SerializeField] private bool _renderMLCapture;
  private Texture2D _previewTexture;

  // boolean for toggling the detection from outside scripts
  [NonSerialized] public Boolean MediaPipeDisabled = false;

  // D: reference the ARcursor script
  public UnityEngine.Events.UnityEvent<object, OutputEventArgs<List<Detection>>> callbackEvent;

  private Stopwatch _stopwatch;

  // Buffers live outside the #if so the shared ReleaseResources() compiles in
  // both builds.
  // MediaPipe's MpImage ctor that takes a NativeArray WRAPS that memory, it does
  // not copy it (see Image.cs: "pixelData won't be released ... you can reuse
  // the memory"). In LIVE_STREAM mode the graph reads the buffer on its own
  // thread while ARCore delivers the next frame, so a single buffer would be
  // overwritten mid-read and produce torn images. Rotate through a few.
  private const int _LiveStreamBufferCount = 3;
  private NativeArray<byte>[] _liveStreamBuffers;
  private int _liveStreamIndex;

  // IMAGE mode only: synchronous path, buffer is fully consumed before return.
  private NativeArray<byte> _imageModeBuffer;

  // Legacy path only.
  private NativeArray<byte> _legacyBuffer;

#if MEDIAPIPE_TASKS

  [SerializeField] private string _modelAssetPath = "ssdlite_object_detection.bytes";

  private ObjectDetector _detector;
  private TaskDetectionResult _resultBuffer;
  private Boolean _detectorReady;

  // Results arrive on MediaPipe's worker thread; they are handed to the main
  // thread through this queue instead of raising Unity events off-thread.
  private readonly ConcurrentQueue<List<Detection>> _pendingResults = new ConcurrentQueue<List<Detection>>();

  // Only used when the TFLite model carries no label metadata.
  // Mirrors ssdlite_object_detection_labelmap.txt (COCO 90 + background, index 0).
  private static readonly string[] _CocoLabels =
  {
    "???", "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "???", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
    "???", "backpack", "umbrella", "???", "???", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "???", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli",
    "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
    "???", "dining table", "???", "???", "toilet", "???", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "???", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
  };

  [Header("Tasks API options")]
  [Tooltip("LIVE_STREAM returns immediately and drops frames under load. IMAGE blocks the caller but has no buffer-lifetime hazard.")]
  [SerializeField] private CoreRunningMode _runningMode = CoreRunningMode.LIVE_STREAM;

  [Tooltip("Passed to ObjectDetectorOptions.categoryAllowList. Empty = detect every class. Replaces ARCursor.allowedObjectLabels as the filter point.")]
  [SerializeField] private List<string> _categoryAllowList = new List<string>
  {
    "bottle", "cup", "bowl", "cell phone", "laptop", "mouse", "vase", "potted plant",
    "apple", "orange", "backpack", "handbag",
  };

  [SerializeField] private int _maxResults = 5;
  [SerializeField, Range(0f, 1f)] private float _scoreThreshold = 0.35f;

  [Tooltip("EDGETPU_NNAPI is MediaPipe's NNAPI delegate. Automatically retried on CPU if it fails to initialise.")]
  [SerializeField] private DelegateKind _delegate = DelegateKind.CPU;

  [Tooltip("Log detection counts to the console.")]
  [SerializeField] private bool _verboseLogging = false;

  public enum DelegateKind { CPU, EDGETPU_NNAPI }
  public enum CoreRunningMode { IMAGE, LIVE_STREAM }

  private IEnumerator Start()
  {
    ResolveCameraManager();

    if (_cameraManager == null)
    {
      Debug.LogError("ARMPObjectDetection: no ARCameraManager found, detection disabled.");
      enabled = false;
      yield break;
    }

    _stopwatch = Stopwatch.StartNew();

    // On Android, StreamingAssets live inside the APK, so the model must be
    // extracted to persistentDataPath before MediaPipe can open it.
    var resourceManager = new StreamingAssetsResourceManager();
    yield return resourceManager.PrepareAssetAsync(_modelAssetPath);

    InitDetector();

    if (_detectorReady)
    {
      _cameraManager.frameReceived += OnCameraFrameReceived;
    }
    else
    {
      Debug.LogError("ARMPObjectDetection: detector not initialised, frame subscription skipped.");
    }
  }

  private void ResolveCameraManager()
  {
    if (_cameraManager == null)
    {
      _cameraManager = GetComponent<ARCameraManager>();
    }
    if (_cameraManager == null)
    {
      // FindFirstObjectByType exists only from Unity 2022.2; the legacy
      // MEDIAPIPE_TASKS-less build still targets 2021.3.
#if UNITY_2022_2_OR_NEWER
      _cameraManager = FindFirstObjectByType<ARCameraManager>();
#else
      _cameraManager = FindObjectOfType<ARCameraManager>();
#endif
    }
  }

  private void InitDetector()
  {
    if (!ResourceUtil.TryGetFilePath(_modelAssetPath, out var modelPath) || !File.Exists(modelPath))
    {
      Debug.LogError($"ARMPObjectDetection: model '{_modelAssetPath}' is not prepared (looked for {modelPath}).");
      return;
    }

    var modelBuffer = File.ReadAllBytes(modelPath);
    var runningMode = _runningMode == CoreRunningMode.LIVE_STREAM ? RunningMode.LIVE_STREAM : RunningMode.IMAGE;
    var allowList = (_categoryAllowList != null && _categoryAllowList.Count > 0)
      ? new List<string>(_categoryAllowList)
      : null;

    var delegateKind = _delegate == DelegateKind.EDGETPU_NNAPI
      ? BaseOptions.Delegate.EDGETPU_NNAPI
      : BaseOptions.Delegate.CPU;

    if (TryCreateDetector(modelBuffer, runningMode, allowList, delegateKind))
    {
      return;
    }

    // NNAPI is not guaranteed on every device/driver: retry the same options on CPU.
    if (delegateKind == BaseOptions.Delegate.EDGETPU_NNAPI)
    {
      Debug.LogWarning("ARMPObjectDetection: NNAPI delegate failed to initialise, retrying on CPU.");
      TryCreateDetector(modelBuffer, runningMode, allowList, BaseOptions.Delegate.CPU);
    }
  }

  private bool TryCreateDetector(byte[] modelBuffer, RunningMode runningMode, List<string> allowList, BaseOptions.Delegate delegateKind)
  {
    try
    {
      var options = new ObjectDetectorOptions(
        baseOptions: new BaseOptions(delegateCase: delegateKind, modelAssetBuffer: modelBuffer),
        runningMode: runningMode,
        displayNamesLocale: null,
        maxResults: _maxResults,
        scoreThreshold: _scoreThreshold,
        categoryAllowList: allowList,
        categoryDenyList: null,
        resultCallback: runningMode == RunningMode.LIVE_STREAM ? OnLiveStreamResult : null);

      _detector = ObjectDetector.CreateFromOptions(options);
      _resultBuffer = TaskDetectionResult.Alloc(_maxResults);
      _detectorReady = true;
      Debug.Log($"ARMPObjectDetection: Tasks API ready (mode {runningMode}, delegate {delegateKind}).");
      return true;
    }
    catch (Exception e)
    {
      Debug.LogError($"ARMPObjectDetection: detector init failed on {delegateKind}: {e}");
      _detector = null;
      _detectorReady = false;
      return false;
    }
  }

  // Invoked on MediaPipe's worker thread. Must not touch Unity APIs.
  private void OnLiveStreamResult(TaskDetectionResult result, MpImage image, long timestampMillisec)
  {
    try
    {
      if (image == null)
      {
        return;
      }

      var converted = ToLegacyDetections(result, image.Width(), image.Height());
      _pendingResults.Enqueue(converted);
    }
    catch (Exception e)
    {
      Debug.LogError($"ARMPObjectDetection: result conversion failed: {e}");
    }
  }

  private void Update()
  {
    while (_pendingResults.TryDequeue(out var detections))
    {
      if (_verboseLogging)
      {
        Debug.Log($"ARMPObjectDetection: {detections.Count} detection(s)");
      }
      callbackEvent?.Invoke(this, new OutputEventArgs<List<Detection>>(detections));
    }
  }

  /// <summary>
  /// Converts Tasks API detections (bounding boxes in PIXELS of the image handed
  /// to the detector) into <see cref="Mediapipe.Detection"/> protos carrying a
  /// NORMALISED RelativeBoundingBox, which is what ARCursor consumes.
  /// </summary>
  private List<Detection> ToLegacyDetections(TaskDetectionResult result, int imageWidth, int imageHeight)
  {
    var detections = new List<Detection>(result.detections?.Count ?? 0);
    if (result.detections == null || result.detections.Count == 0)
    {
      return detections;
    }

    var width = Mathf.Max(1, imageWidth);
    var height = Mathf.Max(1, imageHeight);
    var hasMetadataLabels = HasMetadataLabels(result);

    foreach (TaskDetection source in result.detections)
    {
      if (source.categories == null || source.categories.Count == 0)
      {
        continue;
      }

      var category = source.categories[0];
      var label = ResolveLabel(category, hasMetadataLabels);

      var box = source.boundingBox;
      var detection = new Detection
      {
        LocationData = new LocationData
        {
          RelativeBoundingBox = new LocationData.Types.RelativeBoundingBox
          {
            Xmin = Mathf.Clamp01(box.left / width),
            Ymin = Mathf.Clamp01(box.top / height),
            Width = Mathf.Clamp01((box.right - box.left) / width),
            Height = Mathf.Clamp01((box.bottom - box.top) / height),
          },
        },
      };

      detection.Label.Add(label);
      detection.LabelId.Add(category.index);
      detection.Score.Add(category.score);
      detection.DisplayName.Add(label);

      detections.Add(detection);
    }

    return detections;
  }

  private static string ResolveLabel(Mediapipe.Tasks.Components.Containers.Category category, bool hasMetadataLabels)
  {
    if (!string.IsNullOrEmpty(category.displayName))
    {
      return category.displayName;
    }
    if (!string.IsNullOrEmpty(category.categoryName))
    {
      return category.categoryName;
    }
    if (!hasMetadataLabels && category.index >= 0 && category.index < _CocoLabels.Length)
    {
      return _CocoLabels[category.index];
    }
    return "unknown";
  }

  private static bool HasMetadataLabels(TaskDetectionResult result)
  {
    if (result.detections == null)
    {
      return false;
    }
    foreach (TaskDetection detection in result.detections)
    {
      if (detection.categories == null)
      {
        continue;
      }
      foreach (var category in detection.categories)
      {
        if (!string.IsNullOrEmpty(category.categoryName) || !string.IsNullOrEmpty(category.displayName))
        {
          return true;
        }
      }
    }
    return false;
  }

  /// <summary>
  /// Replaces categoryAllowList at runtime by rebuilding the detector.
  /// ARCursor can push its own policy here instead of filtering after the fact.
  /// </summary>
  public void SetCategoryAllowList(List<string> labels)
  {
    _categoryAllowList = labels != null ? new List<string>(labels) : new List<string>();

    if (_cameraManager != null)
    {
      _cameraManager.frameReceived -= OnCameraFrameReceived;
    }

    if (_detector != null)
    {
      // Dispose() closes the graph internally when it is still open.
      _detector.Dispose();
      _detector = null;
    }
    _detectorReady = false;

    // The model has already been extracted by Start(), so this stays synchronous.
    InitDetector();

    if (_detectorReady && _cameraManager != null)
    {
      _cameraManager.frameReceived += OnCameraFrameReceived;
    }
  }

  private void OnCameraFrameReceived(ARCameraFrameEventArgs eventArgs)
  {
    if (MediaPipeDisabled || !_detectorReady)
    {
      return;
    }

    if (!_cameraManager.TryAcquireLatestCpuImage(out var image))
    {
      return;
    }

    try
    {
      // Read dimensions BEFORE Dispose: touching image.width afterwards throws.
      var imageWidth = image.width;
      var croppedHeight = (int)((float)image.width / UnityEngine.Device.Screen.width * UnityEngine.Device.Screen.height);
      if (croppedHeight <= 0 || croppedHeight > image.height)
      {
        croppedHeight = image.height;
      }
      var startY = (image.height - croppedHeight) / 2;

      var buffer = AcquireFrameBuffer(imageWidth, croppedHeight);

      var conversionParams = new XRCpuImage.ConversionParams
      {
        inputRect = new RectInt(0, startY, imageWidth, croppedHeight),
        outputDimensions = new Vector2Int(imageWidth, croppedHeight),
        outputFormat = TextureFormat.RGBA32,
      };

      var ptr = (IntPtr)NativeArrayUnsafeUtility.GetUnsafePtr(buffer);
      image.Convert(conversionParams, ptr, buffer.Length);

      if (_renderMLCapture)
      {
        UpdatePreviewTexture(buffer, imageWidth, croppedHeight);
      }

      // MpImage wraps `buffer` without copying.
      using (var mpImage = new MpImage(
        MpImageFormat.Types.Format.Srgba, imageWidth, croppedHeight, 4 * imageWidth, buffer))
      {
        if (_runningMode == CoreRunningMode.LIVE_STREAM)
        {
          var timestampMillisec = (long)(_stopwatch.ElapsedTicks / TimeSpan.TicksPerMillisecond);
          _detector.DetectAsync(mpImage, timestampMillisec);
          return;
        }

        // IMAGE mode. NOTE: when nothing is detected the Tasks API leaves
        // `result` untouched, so clear it first or stale boxes would be emitted.
        if (_resultBuffer.detections != null)
        {
          _resultBuffer.detections.Clear();
        }

        if (_detector.TryDetect(mpImage, null, ref _resultBuffer))
        {
          var detections = ToLegacyDetections(_resultBuffer, imageWidth, croppedHeight);
          callbackEvent?.Invoke(this, new OutputEventArgs<List<Detection>>(detections));
        }
      }
    }
    catch (Exception e)
    {
      Debug.LogError($"ARMPObjectDetection: frame handling failed: {e}");
    }
    finally
    {
      image.Dispose();
    }
  }

  private NativeArray<byte> AcquireFrameBuffer(int width, int height)
  {
    var length = width * height * 4;

    if (_runningMode == CoreRunningMode.LIVE_STREAM)
    {
      if (_liveStreamBuffers == null)
      {
        _liveStreamBuffers = new NativeArray<byte>[_LiveStreamBufferCount];
      }

      var slot = _liveStreamIndex;
      _liveStreamIndex = (_liveStreamIndex + 1) % _LiveStreamBufferCount;

      var existing = _liveStreamBuffers[slot];
      if (!existing.IsCreated || existing.Length != length)
      {
        if (existing.IsCreated)
        {
          existing.Dispose();
        }
        existing = new NativeArray<byte>(length, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
        _liveStreamBuffers[slot] = existing;
      }
      return existing;
    }

    if (!_imageModeBuffer.IsCreated || _imageModeBuffer.Length != length)
    {
      if (_imageModeBuffer.IsCreated)
      {
        _imageModeBuffer.Dispose();
      }
      _imageModeBuffer = new NativeArray<byte>(length, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
    }
    return _imageModeBuffer;
  }

#else // ---------------- legacy CalculatorGraph path (plugin v0.12.0) ----------------

  [SerializeField] private TextAsset _configText; // attach  'object_detection_gpu' or `face_detection_gpu.txt`

  public Boolean renderMLCapture
  {
    get => _renderMLCapture;
    set => _renderMLCapture = value;
  }

  private CalculatorGraph _calculatorGraph;
  private GpuResources _gpuResources;
  private ResourceManager _resourceManager;
  private OutputStream<DetectionVectorPacket, List<Detection>> _outputDetectionsStream;

  private IEnumerator Start()
  {
    if (_cameraManager == null)
    {
      _cameraManager = GetComponent<ARCameraManager>();
    }
    if (_cameraManager == null || _configText == null)
    {
      Debug.LogError("ARMPObjectDetection: missing ARCameraManager or graph config, detection disabled.");
      enabled = false;
      yield break;
    }

    _stopwatch = Stopwatch.StartNew();
    _cameraManager.frameReceived += OnCameraFrameReceived;

    _resourceManager = new StreamingAssetsResourceManager();
    yield return _resourceManager.PrepareAssetAsync("ssdlite_object_detection_labelmap.txt");
    yield return _resourceManager.PrepareAssetAsync("ssdlite_object_detection.bytes");

    _gpuResources = GpuResources.Create().Value();
    _calculatorGraph = new CalculatorGraph(_configText.text);
    _calculatorGraph.SetGpuResources(_gpuResources).AssertOk();

    _outputDetectionsStream = new OutputStream<DetectionVectorPacket, List<Detection>>(_calculatorGraph, "output_detections");
    _outputDetectionsStream.AddListener(callbackEvent.Invoke);

    var sidePacket = new SidePacket();
    sidePacket.Emplace("input_rotation", new IntPacket(0));
    sidePacket.Emplace("input_horizontally_flipped", new BoolPacket(false));
    sidePacket.Emplace("input_vertically_flipped", new BoolPacket(true));
    sidePacket.Emplace("model_type", new IntPacket(0));

    _calculatorGraph.StartRun(sidePacket).AssertOk();
  }

  private void OnCameraFrameReceived(ARCameraFrameEventArgs eventArgs)
  {
    if (MediaPipeDisabled || _calculatorGraph == null)
    {
      return;
    }

    if (!_cameraManager.TryAcquireLatestCpuImage(out var image))
    {
      return;
    }

    try
    {
      var imageWidth = image.width;
      var croppedHeight = (int)((float)image.width / UnityEngine.Device.Screen.width * UnityEngine.Device.Screen.height);
      if (croppedHeight <= 0 || croppedHeight > image.height)
      {
        croppedHeight = image.height;
      }
      var startY = (image.height - croppedHeight) / 2;

      var length = imageWidth * croppedHeight * 4;
      if (!_legacyBuffer.IsCreated || _legacyBuffer.Length != length)
      {
        if (_legacyBuffer.IsCreated)
        {
          _legacyBuffer.Dispose();
        }
        _legacyBuffer = new NativeArray<byte>(length, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
      }

      var conversionParams = new XRCpuImage.ConversionParams
      {
        inputRect = new RectInt(0, startY, imageWidth, croppedHeight),
        outputDimensions = new Vector2Int(imageWidth, croppedHeight),
        outputFormat = TextureFormat.RGBA32,
      };

      var ptr = (IntPtr)NativeArrayUnsafeUtility.GetUnsafePtr(_legacyBuffer);
      image.Convert(conversionParams, ptr, _legacyBuffer.Length);

      if (_renderMLCapture)
      {
        UpdatePreviewTexture(_legacyBuffer, imageWidth, croppedHeight);
      }

      var imageFrame = new ImageFrame(ImageFormat.Types.Format.Srgba, imageWidth, croppedHeight, 4 * imageWidth, _legacyBuffer);
      var currentTimestamp = _stopwatch.ElapsedTicks / (TimeSpan.TicksPerMillisecond / 1000);
      var imageFramePacket = new ImageFramePacket(imageFrame, new Timestamp(currentTimestamp));

      _calculatorGraph.AddPacketToInputStream("input_video", imageFramePacket).AssertOk();
    }
    finally
    {
      image.Dispose();
    }
  }

  private void OnDestroy()
  {
    if (_cameraManager != null)
    {
      _cameraManager.frameReceived -= OnCameraFrameReceived;
    }

    if (_calculatorGraph != null)
    {
      var status = _calculatorGraph.CloseAllPacketSources();
      if (!status.Ok())
      {
        Debug.Log($"Failed to close packet sources: {status}");
      }

      status = _calculatorGraph.WaitUntilDone();
      if (!status.Ok())
      {
        Debug.Log(status);
      }

      _calculatorGraph.Dispose();
    }

    if (_gpuResources != null)
    {
      _gpuResources.Dispose();
    }

    ReleaseResources();
  }

#endif

  // ---------------- shared helpers ----------------

  /// <summary>Reuses one Texture2D instead of allocating a new one per frame.</summary>
  private void UpdatePreviewTexture(NativeArray<byte> source, int width, int height)
  {
    if (_rawImage == null)
    {
      return;
    }

    if (_previewTexture == null || _previewTexture.width != width || _previewTexture.height != height)
    {
      if (_previewTexture != null)
      {
        Destroy(_previewTexture);
      }
      _previewTexture = new Texture2D(width, height, TextureFormat.RGBA32, false);
      _rawImage.texture = _previewTexture;
    }

    _previewTexture.LoadRawTextureData(source);
    _previewTexture.Apply();
  }

  private void ReleaseResources()
  {
    if (_imageModeBuffer.IsCreated)
    {
      _imageModeBuffer.Dispose();
    }

    if (_liveStreamBuffers != null)
    {
      foreach (var buffer in _liveStreamBuffers)
      {
        if (buffer.IsCreated)
        {
          buffer.Dispose();
        }
      }
      _liveStreamBuffers = null;
    }

    if (_legacyBuffer.IsCreated)
    {
      _legacyBuffer.Dispose();
    }

    if (_previewTexture != null)
    {
      Destroy(_previewTexture);
      _previewTexture = null;
    }
  }

  private void OnDisable()
  {
    MediaPipeDisabled = true;
  }

  private void OnEnable()
  {
    MediaPipeDisabled = false;
  }

#if MEDIAPIPE_TASKS
  private void OnDestroy()
  {
    if (_cameraManager != null)
    {
      _cameraManager.frameReceived -= OnCameraFrameReceived;
    }

    if (_detector != null)
    {
      // Dispose() closes the graph internally when it is still open.
      _detector.Dispose();
      _detector = null;
    }

    ReleaseResources();
  }
#endif
}
