export type DeviceModePreference = 'auto' | 'mobile' | 'tablet' | 'desktop';
export type TouchControlsPreference = 'auto' | 'on' | 'off';
export type GraphicsQualityPreference = 'low' | 'medium' | 'high';
export type ResolvedDeviceProfile = 'mobile-portrait' | 'mobile-landscape' | 'tablet' | 'desktop';

export interface DeviceEnvironmentInput {
  width: number;
  height: number;
  hasCoarsePointer?: boolean;
  maxTouchPoints?: number;
  devicePixelRatio?: number;
}

export interface ScreenOptimizationInput extends DeviceEnvironmentInput {
  modePref: DeviceModePreference;
  touchPref: TouchControlsPreference;
  controlScale?: number;
  graphicsQuality?: GraphicsQualityPreference;
}

export interface ResolvedScreenOptimization {
  profile: ResolvedDeviceProfile;
  detectedProfile: ResolvedDeviceProfile;
  modePref: DeviceModePreference;
  orientation: 'portrait' | 'landscape';
  isCompact: boolean;
  showTouchControls: boolean;
  controlScale: number;
  hudScale: number;
  dprCap: number;
  targetCombatSpan: number;
  minimapSize: number;
  minimapX: number;
  minimapY: number;
}

export const VALID_DEVICE_MODES: readonly DeviceModePreference[] = ['auto', 'mobile', 'tablet', 'desktop'];
export const VALID_TOUCH_MODES: readonly TouchControlsPreference[] = ['auto', 'on', 'off'];

export function clampControlScale(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.max(0.75, Math.min(1.25, n)) * 100) / 100;
}

export function detectDeviceProfile(env: DeviceEnvironmentInput): ResolvedDeviceProfile {
  const width = Math.max(240, Math.floor(Number(env.width) || 1280));
  const height = Math.max(240, Math.floor(Number(env.height) || 720));
  const minDim = Math.min(width, height);
  const maxDim = Math.max(width, height);
  const isPortrait = height > width;
  const isTouch = Boolean(env.hasCoarsePointer || (env.maxTouchPoints || 0) > 0);

  if (minDim <= 540 || (isPortrait && width <= 600) || (isTouch && minDim <= 560 && maxDim <= 960)) {
    return isPortrait ? 'mobile-portrait' : 'mobile-landscape';
  }
  if ((isTouch && maxDim <= 1366) || (!isTouch && width < 1024)) {
    return 'tablet';
  }
  return 'desktop';
}

export function resolveScreenOptimization(input: ScreenOptimizationInput): ResolvedScreenOptimization {
  const width = Math.max(240, Math.floor(Number(input.width) || 1280));
  const height = Math.max(240, Math.floor(Number(input.height) || 720));
  const orientation: 'portrait' | 'landscape' = height > width ? 'portrait' : 'landscape';
  const modePref: DeviceModePreference = VALID_DEVICE_MODES.includes(input.modePref) ? input.modePref : 'auto';
  const touchPref: TouchControlsPreference = VALID_TOUCH_MODES.includes(input.touchPref) ? input.touchPref : 'auto';
  const quality: GraphicsQualityPreference =
    input.graphicsQuality === 'low' || input.graphicsQuality === 'medium' || input.graphicsQuality === 'high'
      ? input.graphicsQuality
      : 'high';

  const detectedProfile = detectDeviceProfile(input);
  let profile: ResolvedDeviceProfile;
  if (modePref === 'auto') {
    profile = detectedProfile;
  } else if (modePref === 'mobile') {
    profile = orientation === 'portrait' ? 'mobile-portrait' : 'mobile-landscape';
  } else {
    profile = modePref;
  }

  const isTouchDevice = Boolean(input.hasCoarsePointer || (input.maxTouchPoints || 0) > 0);
  const showTouchControls =
    touchPref === 'on'
      ? true
      : touchPref === 'off'
        ? false
        : profile !== 'desktop' || isTouchDevice;

  const userScale = clampControlScale(input.controlScale ?? 1);
  let autoControlFit = 1;
  if (profile === 'mobile-landscape') {
    autoControlFit = Math.min(0.76, Math.max(0.58, Math.min(width / 960, height / 490)));
  } else if (profile === 'mobile-portrait') {
    autoControlFit = Math.min(0.84, Math.max(0.66, width / 470));
  } else if (profile === 'tablet') {
    autoControlFit = 0.92;
  }
  const controlScale = Math.round(Math.max(0.54, Math.min(1.25, autoControlFit * userScale)) * 100) / 100;

  const hudScale =
    profile === 'mobile-landscape'
      ? Math.round(Math.max(0.8, Math.min(1.05, 0.88 * userScale)) * 100) / 100
      : profile === 'mobile-portrait'
        ? Math.round(Math.max(0.82, Math.min(1.08, 0.92 * userScale)) * 100) / 100
        : Math.round(Math.max(0.85, Math.min(1.15, userScale)) * 100) / 100;

  let dprCap = 2;
  if (quality === 'low') {
    dprCap = 1;
  } else if (quality === 'medium') {
    dprCap = profile === 'desktop' ? 1.5 : 1.25;
  } else {
    dprCap = profile === 'desktop' ? 2 : profile === 'tablet' ? 1.75 : 1.5;
  }

  const targetCombatSpan =
    profile === 'mobile-portrait'
      ? 540
      : profile === 'mobile-landscape'
        ? 560
        : profile === 'tablet'
          ? 600
          : 620;

  let minimapSize: number;
  let minimapX: number;
  let minimapY: number;
  if (profile === 'mobile-landscape') {
    minimapSize = Math.round(Math.max(66, Math.min(92, height * 0.21)));
    minimapX = 10;
    minimapY = Math.round(Math.max(82, Math.min(92, height - minimapSize - 118)));
  } else if (profile === 'mobile-portrait') {
    minimapSize = Math.round(Math.max(74, Math.min(96, width * 0.22)));
    minimapX = 10;
    minimapY = 104;
  } else if (profile === 'tablet') {
    minimapSize = Math.round(Math.max(94, Math.min(118, Math.min(width, height) * 0.16)));
    minimapX = 14;
    minimapY = 118;
  } else {
    minimapSize = Math.round(Math.max(96, Math.min(128, Math.min(width, height) * 0.18)));
    minimapX = 14;
    minimapY = Math.round(Math.max(12, Math.min(122, height - minimapSize - 12)));
  }

  return {
    profile,
    detectedProfile,
    modePref,
    orientation,
    isCompact: profile === 'mobile-portrait' || profile === 'mobile-landscape',
    showTouchControls,
    controlScale,
    hudScale,
    dprCap,
    targetCombatSpan,
    minimapSize,
    minimapX,
    minimapY
  };
}

export function computeAdaptiveCameraZoom(
  width: number,
  height: number,
  zoomMode: string,
  targetCombatSpan: number
): number {
  if (zoomMode === '0.6') return 0.6;
  if (zoomMode === '0.8') return 0.8;
  if (zoomMode === '1.0') return 1.0;
  const minDim = Math.max(240, Math.min(width, height));
  const span = Math.max(360, targetCombatSpan || 620);
  return Math.max(0.5, Math.min(1.05, minDim / span));
}
