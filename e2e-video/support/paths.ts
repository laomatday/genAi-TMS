/**
 * Shared with the config, so it lives away from anything that calls `test()`.
 * Playwright loads the config before the test runner exists, and importing a
 * spec from there fails with "did not expect test() to be called here".
 */
export const AUTH_STATE = '.cache/video-auth.json';
