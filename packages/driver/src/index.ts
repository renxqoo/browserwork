export type { BackendKind, CreateDriverOptions } from "./backends.ts";
export { createWebViewDriver } from "./backends.ts";
export type { FakePageOptions } from "./fake.ts";
export { FakeDriver, FakePage } from "./fake.ts";
export { WebViewPage } from "./page.ts";
export type {
  ClickOptions,
  Driver,
  DriverCapabilities,
  NavigationFailedListener,
  NavigationListener,
  Page,
  PageOptions,
  PressModifier,
  ScreenshotFormat,
  ScreenshotOptions,
} from "./types.ts";
export { classifyClickError } from "./types.ts";
