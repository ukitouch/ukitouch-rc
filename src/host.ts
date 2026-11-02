/**
 * The host runtime this extension runs on.
 */
const host = window.ukitouch;

export const {
  React,
  createStore,
  defineExtension,
  getHostInfo,
  setFullscreen,
  nativeCall,
} = host;

export const { Button, PageHeader, PeerDeviceSearch, PinchArea, Select, SettingRow } =
  host.components;
