import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampControlScale,
  computeAdaptiveCameraZoom,
  detectDeviceProfile,
  resolveScreenOptimization
} from './deviceOptimization';

test('detectDeviceProfile auto-detects mobile portrait, mobile landscape, tablet, and desktop viewports', () => {
  assert.equal(detectDeviceProfile({ width: 390, height: 844, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-portrait');
  assert.equal(detectDeviceProfile({ width: 844, height: 390, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-landscape');
  assert.equal(detectDeviceProfile({ width: 667, height: 375, hasCoarsePointer: true, maxTouchPoints: 5 }), 'mobile-landscape');
  assert.equal(detectDeviceProfile({ width: 820, height: 1180, hasCoarsePointer: true, maxTouchPoints: 5 }), 'tablet');
  assert.equal(detectDeviceProfile({ width: 1440, height: 900, hasCoarsePointer: false, maxTouchPoints: 0 }), 'desktop');
});

test('manual mode preference overrides auto detection cleanly and preserves orientation on mobile', () => {
  const forcedMobileLandscape = resolveScreenOptimization({
    modePref: 'mobile',
    touchPref: 'auto',
    width: 1440,
    height: 900,
    hasCoarsePointer: false,
    maxTouchPoints: 0,
    graphicsQuality: 'high'
  });
  assert.equal(forcedMobileLandscape.detectedProfile, 'desktop');
  assert.equal(forcedMobileLandscape.profile, 'mobile-landscape');
  assert.equal(forcedMobileLandscape.showTouchControls, true);
  assert.equal(forcedMobileLandscape.dprCap, 1.5);

  const forcedDesktopOnPhone = resolveScreenOptimization({
    modePref: 'desktop',
    touchPref: 'off',
    width: 844,
    height: 390,
    hasCoarsePointer: true,
    maxTouchPoints: 5,
    graphicsQuality: 'high'
  });
  assert.equal(forcedDesktopOnPhone.detectedProfile, 'mobile-landscape');
  assert.equal(forcedDesktopOnPhone.profile, 'desktop');
  assert.equal(forcedDesktopOnPhone.showTouchControls, false);
  assert.equal(forcedDesktopOnPhone.dprCap, 2);
});

test('touch controls preference, control scale clamping, and minimap geometry prevent overlap on small screens', () => {
  assert.equal(clampControlScale(0.2), 0.75);
  assert.equal(clampControlScale(2.5), 1.25);
  assert.equal(clampControlScale('bad'), 1);

  const seLandscape = resolveScreenOptimization({
    modePref: 'auto',
    touchPref: 'auto',
    controlScale: 1.0,
    width: 667,
    height: 375,
    hasCoarsePointer: true,
    maxTouchPoints: 5
  });
  assert.equal(seLandscape.profile, 'mobile-landscape');
  assert.ok(seLandscape.minimapY >= 76, 'minimap stays below top stats bar');
  assert.ok(seLandscape.minimapY + seLandscape.minimapSize <= 253, 'minimap clears bottom joystick zone');
  assert.ok(seLandscape.controlScale <= 0.76, 'compact touch controls scale down on small landscape phones');

  const desktopAuto = resolveScreenOptimization({
    modePref: 'auto',
    touchPref: 'auto',
    controlScale: 1.15,
    width: 1440,
    height: 900,
    hasCoarsePointer: false,
    maxTouchPoints: 0
  });
  assert.equal(desktopAuto.showTouchControls, false);
  assert.equal(desktopAuto.controlScale, 1.15);

  const desktopTouchOn = resolveScreenOptimization({
    modePref: 'auto',
    touchPref: 'on',
    width: 1440,
    height: 900,
    hasCoarsePointer: false,
    maxTouchPoints: 0
  });
  assert.equal(desktopTouchOn.showTouchControls, true);
});

test('adaptive camera zoom scales smoothly for mobile vs desktop and respects manual zoom lock', () => {
  const mobileZoom = computeAdaptiveCameraZoom(390, 844, 'auto', 540);
  const desktopZoom = computeAdaptiveCameraZoom(1440, 900, 'auto', 620);
  assert.ok(mobileZoom >= 0.65 && mobileZoom <= 0.8, `expected readable mobile zoom, got ${mobileZoom}`);
  assert.ok(desktopZoom >= 0.95 && desktopZoom <= 1.05, `expected full desktop zoom, got ${desktopZoom}`);
  assert.equal(computeAdaptiveCameraZoom(390, 844, '0.6', 540), 0.6);
});
