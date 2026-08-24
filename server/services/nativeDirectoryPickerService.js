import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

const MAX_DEFAULT_PATH_LENGTH = 2048
const MAX_PICKER_OUTPUT_BYTES = 64 * 1024
const NATIVE_DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60_000
const DEFAULT_PATH_ENV = 'GUGO_NATIVE_DIRECTORY_PICKER_DEFAULT'
let pickerActive = false

const WINDOWS_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$nativeSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class GugoExplorerFolderPicker
{
    private const int ErrorCancelledHResult = unchecked((int)0x800704C7);

    [Flags]
    private enum FOS : uint
    {
        FOS_PICKFOLDERS = 0x00000020,
        FOS_FORCEFILESYSTEM = 0x00000040,
        FOS_PATHMUSTEXIST = 0x00000800,
        FOS_DONTADDTORECENT = 0x02000000
    }

    private enum SIGDN : uint
    {
        SIGDN_FILESYSPATH = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogCom
    {
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filterSpec);
        void SetFileTypeIndex(uint fileTypeIndex);
        void GetFileTypeIndex(out uint fileTypeIndex);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FOS options);
        void GetOptions(out FOS options);
        void SetDefaultFolder(IShellItem shellItem);
        void SetFolder(IShellItem shellItem);
        void GetFolder(out IShellItem shellItem);
        void GetCurrentSelection(out IShellItem shellItem);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem shellItem);
        void AddPlace(IShellItem shellItem, int placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IntPtr items);
        void GetSelectedItems(out IntPtr items);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(SIGDN displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

    public static string PickFolder(IntPtr ownerHandle, string defaultPath, string title)
    {
        object dialogObject = null;
        IShellItem initialFolder = null;
        IShellItem selectedItem = null;
        try
        {
            dialogObject = new FileOpenDialogCom();
            IFileOpenDialog dialog = (IFileOpenDialog)dialogObject;
            FOS options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options
                | FOS.FOS_PICKFOLDERS
                | FOS.FOS_FORCEFILESYSTEM
                | FOS.FOS_PATHMUSTEXIST
                | FOS.FOS_DONTADDTORECENT);
            dialog.SetTitle(title);

            if (!String.IsNullOrWhiteSpace(defaultPath) && Directory.Exists(defaultPath))
            {
                Guid shellItemId = typeof(IShellItem).GUID;
                int folderResult = SHCreateItemFromParsingName(
                    Path.GetFullPath(defaultPath),
                    IntPtr.Zero,
                    ref shellItemId,
                    out initialFolder);
                if (folderResult >= 0 && initialFolder != null)
                {
                    dialog.SetFolder(initialFolder);
                }
            }

            int result = dialog.Show(ownerHandle);
            if (result == ErrorCancelledHResult) return null;
            if (result < 0) Marshal.ThrowExceptionForHR(result);

            dialog.GetResult(out selectedItem);
            if (selectedItem == null) return null;
            IntPtr displayName = IntPtr.Zero;
            try
            {
                selectedItem.GetDisplayName(SIGDN.SIGDN_FILESYSPATH, out displayName);
                return displayName == IntPtr.Zero ? null : Marshal.PtrToStringUni(displayName);
            }
            finally
            {
                if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            }
        }
        finally
        {
            if (selectedItem != null && Marshal.IsComObject(selectedItem)) Marshal.FinalReleaseComObject(selectedItem);
            if (initialFolder != null && Marshal.IsComObject(initialFolder)) Marshal.FinalReleaseComObject(initialFolder);
            if (dialogObject != null && Marshal.IsComObject(dialogObject)) Marshal.FinalReleaseComObject(dialogObject);
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource
$owner = New-Object System.Windows.Forms.Form
try {
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.TopMost = $true
  $owner.Show()
  $owner.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  $defaultPath = [Environment]::GetEnvironmentVariable('${DEFAULT_PATH_ENV}', 'Process')
  $selectedPath = [GugoExplorerFolderPicker]::PickFolder(
    $owner.Handle,
    $defaultPath,
    '选择项目根目录'
  )
  if (-not [String]::IsNullOrWhiteSpace($selectedPath)) {
    $payload = @{ canceled = $false; path = [System.IO.Path]::GetFullPath($selectedPath) }
  } else {
    $payload = @{ canceled = $true; path = '' }
  }
  [Console]::Out.Write(($payload | ConvertTo-Json -Compress))
} finally {
  if ($owner.Visible) { $owner.Close() }
  $owner.Dispose()
}
`.trim()

const WINDOWS_PICKER_ENCODED_SCRIPT = Buffer
  .from(WINDOWS_PICKER_SCRIPT, 'utf16le')
  .toString('base64')

function pickerInputError(message, code) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = code
  return error
}

function pickerRuntimeError(message, code = 'NATIVE_DIRECTORY_PICKER_FAILED', statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function unsupportedPickerResult() {
  return { supported: false, canceled: false, path: '' }
}

function normalizeDefaultPath(value, platform) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length > MAX_DEFAULT_PATH_LENGTH) {
    throw pickerInputError(
      `defaultPath 最多 ${MAX_DEFAULT_PATH_LENGTH} 个字符`,
      'NATIVE_DIRECTORY_PICKER_DEFAULT_PATH_TOO_LONG',
    )
  }
  if (raw.includes('\0')) {
    throw pickerInputError('defaultPath 含有无效字符', 'NATIVE_DIRECTORY_PICKER_DEFAULT_PATH_INVALID')
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(raw)) {
    throw pickerInputError(
      'defaultPath 必须使用绝对路径',
      'NATIVE_DIRECTORY_PICKER_DEFAULT_PATH_ABSOLUTE_REQUIRED',
    )
  }
  return pathApi.normalize(raw)
}

function windowsPowerShellPath(env) {
  const systemRoot = String(env?.SystemRoot || env?.WINDIR || '').trim()
  return systemRoot
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

function canonicalDirectoryPath(value) {
  const selectedPath = String(value || '').trim()
  if (!selectedPath || !path.isAbsolute(selectedPath)) throw new Error('selected path is not absolute')
  const canonicalPath = fs.realpathSync(selectedPath)
  if (!fs.statSync(canonicalPath).isDirectory()) throw new Error('selected path is not a directory')
  return canonicalPath
}

function executePicker(command, args, options, execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl(command, args, options, (error, stdout = '') => {
        resolve({ error, stdout })
      })
    } catch (error) {
      resolve({ error, stdout: '' })
    }
  })
}

/**
 * Open the Windows system folder picker from a loopback-hosted Node process.
 * The fixed script is passed as UTF-16 Base64 and user input travels only in
 * the child environment, so paths cannot alter PowerShell syntax or argv.
 */
export async function selectNativeDirectory({ defaultPath = '' } = {}, {
  platform = process.platform,
  env = process.env,
  execFileImpl = execFile,
  powershellPath = windowsPowerShellPath(env),
  canonicalizeDirectory = canonicalDirectoryPath,
  timeoutMs = NATIVE_DIRECTORY_PICKER_TIMEOUT_MS,
} = {}) {
  if (platform !== 'win32') return unsupportedPickerResult()
  if (pickerActive) {
    throw pickerRuntimeError(
      '系统文件夹选择窗口已打开，请先完成当前选择',
      'NATIVE_DIRECTORY_PICKER_BUSY',
      409,
    )
  }
  const normalizedDefaultPath = normalizeDefaultPath(defaultPath, platform)
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-EncodedCommand',
    WINDOWS_PICKER_ENCODED_SCRIPT,
  ]
  const childEnv = sanitizeChildEnv({
    [DEFAULT_PATH_ENV]: normalizedDefaultPath,
  }, { sourceEnv: env, platform })
  try {
    pickerActive = true
    const { error, stdout } = await executePicker(powershellPath, args, {
      encoding: 'utf8',
      env: childEnv,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_PICKER_OUTPUT_BYTES,
      shell: false,
      timeout: Math.max(1, Number(timeoutMs) || NATIVE_DIRECTORY_PICKER_TIMEOUT_MS),
      windowsHide: true,
    }, execFileImpl)
    if (error?.code === 'ENOENT') return unsupportedPickerResult()
    if (error?.killed || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGKILL') {
      throw pickerRuntimeError(
        '系统文件夹选择窗口等待超时，请重试',
        'NATIVE_DIRECTORY_PICKER_TIMEOUT',
        504,
      )
    }
    if (error) {
      throw pickerRuntimeError('无法打开系统文件夹选择窗口')
    }

    let payload
    try {
      payload = JSON.parse(String(stdout || '').replace(/^\uFEFF/u, '').trim())
    } catch {
      throw pickerRuntimeError('系统文件夹选择器返回了无效结果')
    }
    if (payload?.canceled === true) {
      return { supported: true, canceled: true, path: '' }
    }
    if (!payload?.path) {
      throw pickerRuntimeError('系统文件夹选择器没有返回目录')
    }
    let selectedPath
    try {
      selectedPath = canonicalizeDirectory(payload.path)
    } catch {
      throw pickerRuntimeError(
        '所选目录不存在或无法访问',
        'NATIVE_DIRECTORY_PICKER_SELECTED_PATH_INVALID',
        422,
      )
    }
    return {
      supported: true,
      canceled: false,
      path: selectedPath,
    }
  } finally {
    pickerActive = false
  }
}
