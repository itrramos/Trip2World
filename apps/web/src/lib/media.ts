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

/** Audio is orientation-independent; two people on speakers without these is unusable. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * True when the device is being held in portrait.
 *
 * Falls back to a width check because `orientation` media queries are unreliable on some
 * Android browsers when a soft keyboard is open.
 */
export function isPortrait(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(orientation: portrait)');
    if (typeof query.matches === 'boolean') return query.matches;
  }
  return window.innerHeight >= window.innerWidth;
}

/**
 * Video constraints for the current orientation.
 *
 * This is the fix for the "too much zoom" complaint. Asking a portrait-held phone for a
 * landscape 1280x720 does not give you 720p in portrait — the browser satisfies it by
 * cropping the sensor, which narrows the field of view and makes the caller look like
 * they are pressed against the lens. The crop happens at capture, so it is baked into the
 * stream that gets sent and no amount of CSS on the receiving end can undo it.
 *
 * Requesting dimensions that match how the device is actually held lets the browser pick
 * a native sensor mode instead. `aspectRatio` is supplied alongside because some
 * implementations honour it when they ignore width/height.
 *
 * Everything stays `ideal`. `exact` would hard-fail on perfectly usable cameras.
 */
export function videoConstraints(
  options: { facingMode?: 'user' | 'environment'; deviceId?: string } = {},
): MediaTrackConstraints {
  const portrait = isPortrait();

  return {
    width: { ideal: portrait ? 720 : 1280 },
    height: { ideal: portrait ? 1280 : 720 },
    aspectRatio: { ideal: portrait ? 9 / 16 : 16 / 9 },
    frameRate: { ideal: 30, max: 30 },
    // An explicit deviceId wins over facingMode; supplying both makes the request
    // over-constrained on some devices.
    ...(options.deviceId
      ? { deviceId: { exact: options.deviceId } }
      : { facingMode: options.facingMode ?? 'user' }),
  };
}

export function buildConstraints(
  options: { facingMode?: 'user' | 'environment'; deviceId?: string } = {},
): MediaStreamConstraints {
  return { video: videoConstraints(options), audio: AUDIO_CONSTRAINTS };
}

/** Back-compat alias. Prefer `buildConstraints()` so orientation is evaluated at call time. */
export const PREFERRED_CONSTRAINTS: MediaStreamConstraints = {
  video: { frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
  audio: AUDIO_CONSTRAINTS,
};

/** Minimal fallback used when the preferred constraints are over-constrained. */
const FALLBACK_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: AUDIO_CONSTRAINTS };

export function isMediaSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export async function requestUserMedia(
  constraints: MediaStreamConstraints = buildConstraints(),
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

/* -------------------------------------------------------------------------- */
/* Camera zoom                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Zoom is not in the base TypeScript DOM lib because it is part of the Image Capture
 * spec, which browsers implement unevenly. These narrow interfaces describe only what we
 * actually read, rather than casting to `any` at the call site.
 */
interface ZoomCapableCapabilities extends MediaTrackCapabilities {
  zoom?: { min: number; max: number; step: number };
}
interface ZoomCapableSettings extends MediaTrackSettings {
  zoom?: number;
}

export interface ZoomCapability {
  min: number;
  max: number;
  step: number;
  current: number;
}

/**
 * Read a track's zoom range, or null when the platform does not support it.
 *
 * Chrome on Android exposes this for most cameras. Safari and the large majority of
 * desktop webcams do not, so the caller must treat null as "hide the control" rather
 * than rendering a slider that silently does nothing.
 */
export function getZoomCapability(track: MediaStreamTrack | null): ZoomCapability | null {
  if (!track || typeof track.getCapabilities !== 'function') return null;

  try {
    const capabilities = track.getCapabilities() as ZoomCapableCapabilities;
    const zoom = capabilities.zoom;
    // A range of zero width is advertised by some drivers and is not a usable control.
    if (!zoom || typeof zoom.max !== 'number' || zoom.max <= zoom.min) return null;

    const settings = track.getSettings() as ZoomCapableSettings;

    return {
      min: zoom.min,
      max: zoom.max,
      // Some implementations report step 0, which would make a slider unusable.
      step: zoom.step && zoom.step > 0 ? zoom.step : (zoom.max - zoom.min) / 100,
      current: settings.zoom ?? zoom.min,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a zoom level.
 *
 * Uses `advanced`, which asks the browser to apply the constraint if it can and to carry
 * on if it cannot — a plain constraint would reject the whole call. Failures are
 * swallowed because a camera can advertise a zoom range and still refuse specific values,
 * and a rejected zoom must never interrupt a live call.
 */
export async function applyZoom(track: MediaStreamTrack | null, value: number): Promise<boolean> {
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/** Which way a track's camera is pointing, when the platform reports it. */
export function getFacingMode(track: MediaStreamTrack | null): 'user' | 'environment' | null {
  if (!track) return null;
  const facing = track.getSettings().facingMode;
  return facing === 'user' || facing === 'environment' ? facing : null;
}

/**
 * Acquire a video track from the opposite camera.
 *
 * Video only: re-requesting audio would create a second microphone track that the caller
 * has to reconcile, and on some devices briefly seizes the mic, cutting the user's audio
 * mid-sentence for no reason.
 *
 * Falls back to enumerating devices when `facingMode` is unavailable, which is the normal
 * situation on desktop where cameras have no meaningful front/back.
 */
export async function getOppositeCameraTrack(
  current: MediaStreamTrack | null,
): Promise<MediaStreamTrack> {
  const facing = getFacingMode(current);

  if (facing) {
    const next = facing === 'user' ? 'environment' : 'user';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints({ facingMode: next }),
    });
    const track = stream.getVideoTracks()[0];
    if (track) return track;
  }

  // No facingMode: rotate to the next camera in the device list.
  const { cameras } = await listDevices();
  if (cameras.length < 2) throw new MediaError(MediaErrorKind.NO_DEVICE, 'No second camera.');

  const currentId = current?.getSettings().deviceId;
  const index = cameras.findIndex((camera) => camera.deviceId === currentId);
  const next = cameras[(index + 1) % cameras.length]!;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints({ deviceId: next.deviceId }),
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new MediaError(MediaErrorKind.NO_DEVICE, 'Could not open the other camera.');
  return track;
}
