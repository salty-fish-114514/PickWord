const ONBOARDING_KEY = "pickword-onboarded-v1";

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "1");
  } catch {
    /* 存不下就下次启动再见一次，无伤大雅 */
  }
}

export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) !== "1";
  } catch {
    return false;
  }
}
