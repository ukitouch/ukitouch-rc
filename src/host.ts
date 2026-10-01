/**
 * The host runtime this extension runs on.
 */
const host = window.yatouch;

export const {
  React,
  createStore,
  defineExtension,
  getHostPlatform,
  setFullscreen,
  startScreenStream,
  startInput,
  injectInput,
  releaseInput,
  stopInput,
} = host;

export const { Button, PageHeader, PeerDeviceSearch, PinchArea, Select, SettingRow } =
  host.components;
