// Entwicklung: Vite-Dev-Server mit Hot Reload für die Oberfläche, Electron startet bei
// Änderungen am Hauptprozess neu.
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { mainOptions } from './build.mjs';

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');

let child = null;
let restarting = false;

function startElectron() {
  child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
  child.on('exit', (code) => {
    if (restarting) return;
    void server.close();
    process.exit(code ?? 0);
  });
}

const ctx = await context({
  ...mainOptions,
  plugins: [
    {
      name: 'restart-electron',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length) return;
          if (!child) return startElectron();
          restarting = true;
          child.once('exit', () => {
            restarting = false;
            startElectron();
          });
          child.kill();
        });
      },
    },
  ],
});
await ctx.watch();
