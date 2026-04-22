import { afterEach, describe, expect, it } from 'vitest';
import { getFileSystemAccessStatus } from '@/lib/fsWorkspace';

const originalPicker = (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
const originalSecureContext = window.isSecureContext;

function setPicker(value?: unknown) {
  if (value === undefined) {
    delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    return;
  }

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value,
  });
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  setSecureContext(originalSecureContext);
  setPicker(originalPicker);
});

describe('getFileSystemAccessStatus', () => {
  it('reports support when the directory picker exists', () => {
    setSecureContext(true);
    setPicker(() => Promise.resolve(null));

    expect(getFileSystemAccessStatus()).toEqual({
      supported: true,
      reason: 'supported',
      message: null,
    });
  });

  it('reports insecure-context over LAN/http when the picker is unavailable', () => {
    setSecureContext(false);
    setPicker(undefined);

    expect(getFileSystemAccessStatus()).toEqual({
      supported: false,
      reason: 'insecure-context',
      message: 'Workspace access over the network requires HTTPS in Chrome or Edge. Open EvigStudio via HTTPS or use localhost.',
    });
  });

  it('reports unsupported browsers when secure context is available but picker is missing', () => {
    setSecureContext(true);
    setPicker(undefined);

    expect(getFileSystemAccessStatus()).toEqual({
      supported: false,
      reason: 'unsupported-browser',
      message: 'File System Access requires Chrome or Edge. Firefox/Safari not supported.',
    });
  });
});
