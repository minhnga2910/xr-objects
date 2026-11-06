// Copyright 2024 Google LLC

// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Compatibility shim for the MediaPipe Tasks API build.
//
// MediaPipeUnityPlugin v0.12.0 exposed `Mediapipe.Unity.OutputEventArgs<TValue>`
// as a top-level class with a public `value` field. In v0.16.3 that type was
// removed: `OutputStream<T>` now defines a NESTED `OutputEventArgs` struct that
// carries `packet` / `timestampMicrosecond` instead of `value`.
//
// ARCursor.cs depends on the old shape in two places:
//   public UnityEvent<object, OutputEventArgs<List<Detection>>> callbackEvent
//   public void OutputCallback(object stream, OutputEventArgs<List<Detection>> eventArgs)
//
// Rewriting ARCursor for the new packet shape would also mean teaching it to
// decode DetectionVectorPacket, a packet type that no longer exists. Restoring
// the one type it actually needs is the smaller, safer change.
//
// This file compiles ONLY when MEDIAPIPE_TASKS is defined, so the legacy build
// keeps using the plugin's own type and never sees a duplicate definition.

#if MEDIAPIPE_TASKS

using System;

namespace Mediapipe.Unity
{
  /// <summary>
  /// Carries an output value from a MediaPipe stream to a listener.
  /// Mirrors the v0.12.0 signature so existing consumers compile unchanged.
  /// </summary>
  public class OutputEventArgs<TValue> : EventArgs
  {
    public readonly TValue value;

    public OutputEventArgs(TValue value)
    {
      this.value = value;
    }
  }
}

#endif
