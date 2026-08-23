// Capacitor Preferences adapter (Android SharedPreferences under the hood).
// Deliberately a dumb pass-through: all sealing, validation, and refusal
// logic lives in ./index.ts and is tested against injected backends.

import { Preferences } from "@capacitor/preferences";
import type { KeyValueBackend } from "./index";

export const preferencesBackend: KeyValueBackend = {
  async get(key) {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
};
