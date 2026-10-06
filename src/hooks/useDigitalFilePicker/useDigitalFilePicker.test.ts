import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DIGITAL_FILE_DEFAULT_MAX_BYTES, useDigitalFilePicker } from './useDigitalFilePicker';

function sizedFile(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('useDigitalFilePicker (digital delivery design §2 "Size")', () => {
  it('takes a file within the cap', () => {
    const { result } = renderHook(() => useDigitalFilePicker(1_000));
    const file = sizedFile('guide.pdf', 1_000);

    act(() => result.current.choose(file));

    expect(result.current.file).toBe(file);
    expect(result.current.error).toBeNull();
  });

  it('refuses a file over the deployment cap with the size in the copy', () => {
    const { result } = renderHook(() => useDigitalFilePicker(10 * 1024 * 1024));

    act(() => result.current.choose(sizedFile('big.zip', 10 * 1024 * 1024 + 1)));

    expect(result.current.file).toBeNull();
    expect(result.current.error).toBe('Files can be up to 10 MB for now.');
  });

  it('uses the first-release 50 MB cap when the service reports none', () => {
    const { result } = renderHook(() => useDigitalFilePicker(null));

    act(() => result.current.choose(sizedFile('ok.zip', DIGITAL_FILE_DEFAULT_MAX_BYTES)));
    expect(result.current.file).not.toBeNull();

    act(() => result.current.choose(sizedFile('big.zip', DIGITAL_FILE_DEFAULT_MAX_BYTES + 1)));
    expect(result.current.file).toBeNull();
    expect(result.current.error).toBe('Files can be up to 50 MB for now.');
  });

  it('refuses an empty file and clears on none or reset', () => {
    const { result } = renderHook(() => useDigitalFilePicker(null));

    act(() => result.current.choose(sizedFile('empty.pdf', 0)));
    expect(result.current.error).toBe('Choose a file that is not empty.');

    act(() => result.current.choose(sizedFile('guide.pdf', 10)));
    act(() => result.current.choose(null));
    expect(result.current.file).toBeNull();
    expect(result.current.error).toBeNull();

    act(() => result.current.choose(sizedFile('guide.pdf', 10)));
    act(() => result.current.reset());
    expect(result.current.file).toBeNull();
  });
});
