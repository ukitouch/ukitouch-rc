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
} = host;

export const { Button, PageHeader, PeerDeviceSearch, Select, SettingRow } =
  host.components;
