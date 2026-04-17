import type { ChildProcess } from "node:child_process";

export async function waitForStdout(child: ChildProcess, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output. stdout=${stdout} stderr=${stderr}`));
    }, 15000);

    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Process exited before ready with code ${code}. stdout=${stdout} stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("exit", onExit);
  });
}

export async function waitForExit(child?: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}
