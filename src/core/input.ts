import type { DriveControls, IInput } from './types';

type Action = 'camera' | 'pause' | 'restart' | 'confirm';

const ACTION_KEYS: Record<Action, string[]> = {
  camera: ['KeyC'],
  pause: ['Escape', 'KeyP'],
  restart: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter'],
};

/** Keys whose default browser behaviour (scrolling etc.) must be suppressed while playing. */
const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight',
]);

export class Input implements IInput {
  readonly controls: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
  private down = new Set<string>();
  private justPressed = new Set<string>();
  private frameActions = new Set<Action>();
  private override: Partial<DriveControls> | null = null;
  /** Set false to let key events through to the page (menus with focusable controls). */
  captureKeys = true;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (this.captureKeys && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.justPressed.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    target.addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.down.clear();
    });
  }

  private key(...codes: string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  pressed(action: Action): boolean {
    return this.frameActions.has(action);
  }

  setOverride(c: Partial<DriveControls> | null): void {
    this.override = c;
  }

  update(): void {
    this.frameActions.clear();
    for (const a of Object.keys(ACTION_KEYS) as Action[]) {
      for (const k of ACTION_KEYS[a]) if (this.justPressed.has(k)) this.frameActions.add(a);
    }
    this.justPressed.clear();

    const c = this.controls;
    c.throttle = this.key('KeyW', 'ArrowUp') ? 1 : 0;
    c.brake = this.key('KeyS', 'ArrowDown') ? 1 : 0;
    c.steer = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0);
    c.handbrake = this.key('Space');
    c.nitro = this.key('ShiftLeft', 'ShiftRight');

    // Gamepad (optional nicety; standard mapping).
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected || p.mapping !== 'standard') continue;
      const ax = Math.abs(p.axes[0]) > 0.12 ? p.axes[0] : 0;
      if (ax !== 0) c.steer = ax;
      c.throttle = Math.max(c.throttle, p.buttons[7]?.value ?? 0);
      c.brake = Math.max(c.brake, p.buttons[6]?.value ?? 0);
      c.handbrake = c.handbrake || !!p.buttons[0]?.pressed;
      c.nitro = c.nitro || !!p.buttons[2]?.pressed || !!p.buttons[5]?.pressed;
      break;
    }

    if (this.override) Object.assign(c, this.override);
  }
}
