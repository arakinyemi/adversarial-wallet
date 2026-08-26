// Fingerprint unlock. The biometric never replaces the PIN in the crypto:
// secrets stay encrypted under the PIN, and the fingerprint only releases
// the PIN from the hardware-backed Android Keystore (set up explicitly by
// the user from Settings). Every call fails closed — an unavailable sensor,
// a dismissed prompt, or missing credentials throws, and the keypad is
// always there as fallback.

import { NativeBiometric } from "@capgo/capacitor-native-biometric";

const SERVER = "wallet.cairn.pin";

export async function biometricAvailable(): Promise<boolean> {
  try {
    const result = await NativeBiometric.isAvailable();
    return result.isAvailable;
  } catch {
    // Plugin missing (web/dev builds): biometrics simply aren't offered.
    return false;
  }
}

/** Prompt, then store the PIN in the Keystore. Verification comes first so
 * a failed prompt stores nothing. */
export async function enableBiometricUnlock(pin: string): Promise<void> {
  await NativeBiometric.verifyIdentity({
    reason: "Enable fingerprint unlock",
    title: "Confirm it's you",
  });
  await NativeBiometric.setCredentials({
    username: "pin",
    password: pin,
    server: SERVER,
  });
}

export async function disableBiometricUnlock(): Promise<void> {
  await NativeBiometric.deleteCredentials({ server: SERVER });
}

/** Prompt, then release the stored PIN. Rejection or absence throws. */
export async function biometricUnlock(): Promise<string> {
  await NativeBiometric.verifyIdentity({
    reason: "Unlock Cairn",
    title: "Unlock",
  });
  const credentials = await NativeBiometric.getCredentials({ server: SERVER });
  if (credentials.password === "") {
    throw new Error("No fingerprint unlock is set up on this device.");
  }
  return credentials.password;
}
