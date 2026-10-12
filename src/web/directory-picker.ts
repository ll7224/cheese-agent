import { execFile } from 'node:child_process';
import { RuntimeError } from '../runtime/service.js';

const script = `
ObjC.import('AppKit');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
app.activateIgnoringOtherApps(true);
const panel = $.NSOpenPanel.openPanel;
panel.canChooseFiles = false;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = false;
panel.canCreateDirectories = false;
panel.title = '接入工作目录';
panel.message = '选择 Cheese Agent 的工作文件夹';
panel.prompt = '选择文件夹';
const result = panel.runModal;
JSON.stringify(Number(result) === Number($.NSModalResponseOK) ? ObjC.unwrap(panel.URL.path) : null);
`;

export async function selectLocalDirectory(): Promise<string | null> {
  if (process.platform !== 'darwin') throw new RuntimeError('当前系统暂不支持文件夹选择器，请使用下方的手动输入路径。', 501);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536 }, (error, stdout) => {
      if (error) { reject(new RuntimeError('未能完成文件夹选择，请重试或手动输入路径。', 503)); return; }
      try {
        const path: unknown = JSON.parse(stdout);
        if (path !== null && typeof path !== 'string') throw new Error();
        resolve(path);
      } catch { reject(new RuntimeError('无法读取所选文件夹，请重试或手动输入路径。', 503)); }
    });
  });
}
