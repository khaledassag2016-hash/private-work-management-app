import { defineConfig } from '@playwright/test';

const project = (name, browserName, width, height, level) => ({
  name,
  metadata: { level, width, height },
  testMatch: level === 'A' ? /full-flows\.spec\.mjs/ : /(structural|phase6-visual)\.spec\.mjs/,
  use: { browserName, viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600 },
});

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['line']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4179/__health',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    project('level-a-chromium-mobile', 'chromium', 390, 844, 'A'),
    project('level-a-chromium-desktop', 'chromium', 1280, 720, 'A'),
    project('level-b-chromium-360x800', 'chromium', 360, 800, 'B'),
    project('level-b-chromium-390x844', 'chromium', 390, 844, 'B'),
    project('level-b-chromium-768x1024', 'chromium', 768, 1024, 'B'),
    project('level-b-chromium-844x390', 'chromium', 844, 390, 'B'),
    project('level-b-chromium-1280x720', 'chromium', 1280, 720, 'B'),
    project('level-b-chromium-1440x900', 'chromium', 1440, 900, 'B'),
    project('level-b-firefox-390x844', 'firefox', 390, 844, 'B'),
    project('level-b-firefox-1280x720', 'firefox', 1280, 720, 'B'),
    project('level-b-webkit-390x844', 'webkit', 390, 844, 'B'),
    project('level-b-webkit-1280x720', 'webkit', 1280, 720, 'B'),
  ],
});
