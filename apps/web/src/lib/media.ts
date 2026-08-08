/**
 * Camera and microphone acquisition.
 *
 * getUserMedia fails in a lot of distinct ways, and the browser's own error messages are
 * useless to a user ("Permission denied" tells them nothing about what to do). Every
 * failure is mapped to a specific, actionable state so the UI can say what actually went
 * wrong and how to fix it — a generic "camera error" is the difference between a user
 * fixing their setup and closing the tab.
 */

export const MediaErrorKind = {
  /** User declined, or the browser has a persisted deny for this origin. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** No camera/microphone present at all. */
  NO_DEVICE: 'NO_DEVICE',
  /** Device exists but another application holds it. Common on Windows. */
  DEVICE_BUSY: 'DEVICE_BUSY',
  /** Page is not in a secure context — getUserMedia is unavailable over plain HTTP. */
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  /** Browser does not implement getUserMedia at all. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Constraints could not be satisfied by any available device. */
  OVERCONSTRAINED: 'OVERCONSTRAINED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type MediaErrorKind = (typeof MediaErrorKind)[keyof typeof MediaErrorKind];

export class MediaError extends Error {
  constructor(
    public readonly kind: MediaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** User-facing copy for each failure. Written to be actionable, not merely accurate. */
export const MEDIA_ERROR_COPY: Record<MediaErrorKind, { title: string; body: string; retry: boolean }> = {
  PERMISSION_DENIED: {
    title: 'Trip2World needs your camera and microphone',
    body: 'Video chat cannot work without them. Click the camera icon in your browser’s address bar and allow access, then try again.',
    retry: true,
  },
  NO_DEVICE: {
    title: 'No camera or microphone found',
    body: 'Connect a camera and microphone, then try again. If they are already connected, check they are enabled in your system settings.',
    retry: true,
  },
  DEVICE_BUSY: {
    title: 'Your camera is being used by another app',
    body: 'Close any other app using the camera — a video call, or another browser tab — then try again.',
    retry: true,
  },
  INSECURE_CONTEXT: {
    title: 'This page is not secure',
    body: 'Browsers only allow camera access over HTTPS. Open Trip2World using an https:// address.',
    retry: false,
  },
  UNSUPPORTED: {
    title: 'This browser cannot do video chat',
    body: 'Try a recent version of Chrome, Edge, Firefox or Safari.',
    retry: false,
  },
  OVERCONSTRAINED: {
    title: 'Your camera does not support the required settings',
    body: 'We will try again with basic settings.',
    retry: true,
  },
  UNKNOWN: {
    title: 'We could not start your camera',
    body: 'Something went wrong reaching your camera or microphone. Try again.',
    retry: true,
  },
};

function classify(error: unknown): MediaErrorKind {
  if (!(error instanceof Error)) return MediaErrorKind.UNKNOWN;

  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return MediaErrorKind.PERMISSION_DENIED;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return MediaErrorKind.NO_DEVICE;
    case 'NotReadableError':
    case 'TrackStartError':
      return MediaErrorKind.DEVICE_BUSY;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return MediaErrorKind.OVERCONSTRAINED;
    default:
      return MediaErrorKind.UNKNOWN;
  }
}

/**
 * Preferred constraints.
 *
 * 720p at 30fps is the ceiling, not a demand — `ideal` lets the browser fall back to
 * whatever the camera can do. Requesting `exact` here would hard-fail on perfectly usable
 * webcams. Echo cancellation and noise suppression are on because two people on speakers
 * without them is unusable.
 */
export const PREFERRED_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: 'user',
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

/** Minimal fallback used when the preferred constraints are over-constrained. */
const FALLBACK_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: true };

export function isMediaSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export async function requestUserMedia(
  constraints: MediaStreamConstraints = PREFERRED_CONSTRAINTS,
): Promise<MediaStream> {
  // `isSecureContext` is true for https and for localhost, which is what makes local
  // development work without a certificate.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new MediaError(MediaErrorKind.INSECURE_CONTEXT, 'Camera access requires HTTPS.');
  }
  if (!isMediaSupported()) {
    throw new MediaError(MediaErrorKind.UNSUPPORTED, 'getUserMedia is not available.');
  }

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const kind = classify(error);

    // Retry once with minimal constraints — an unusual webcam should not block the user.
    if (kind === MediaErrorKind.OVERCONSTRAINED) {
      try {
        return await navigator.mediaDevices.getUserMedia(FALLBACK_CONSTRAINTS);
      } catch (fallbackError) {
        throw new MediaError(classify(fallbackError), 'Could not start camera.');
      }
    }

    throw new MediaError(kind, 'Could not start camera.');
  }
}

/**
 * Stop every track on a stream.
 *
 * Essential rather than tidy: until every track is stopped the browser keeps the camera
 * light on, which users reasonably read as still being watched.
 */
export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

/**
 * Enumerate cameras and microphones.
 *
 * Device labels are empty until permission has been granted at least once — that is a
 * privacy protection in the browser, not a bug, so callers must handle unlabelled
 * devices and only offer a picker after permission is held.
 */
export async function listDevices(): Promise<{
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
}> {
  if (!isMediaSupported()) return { cameras: [], microphones: [] };

  const devices = await navigator.mediaDevices.enumerateDevices();

  const map = (kind: MediaDeviceKind, fallback: string): MediaDeviceOption[] =>
    devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }));

  return {
    cameras: map('videoinput', 'Camera'),
    microphones: map('audioinput', 'Microphone'),
  };
}

/** True when the device has more than one camera, i.e. a front/back switch is meaningful. */
export async function hasMultipleCameras(): Promise<boolean> {
  const { cameras } = await listDevices();
  return cameras.length > 1;
}
