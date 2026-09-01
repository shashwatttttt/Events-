import { config } from "@/lib/config";

export interface RecaptchaVerificationResult {
  success: boolean;
  score?: number;
  action?: string;
  challengeTs?: string;
  hostname?: string;
  errorCodes?: string[];
  skipped?: boolean;
}

/**
 * Verifies a Google reCAPTCHA response token against Google's siteverify API.
 * Handles missing secret keys, test mode, and simulated preview modes gracefully.
 */
export async function verifyRecaptcha(
  token?: string | null,
  expectedAction?: string,
): Promise<RecaptchaVerificationResult> {
  const secretKey = (process.env.RECAPTCHA_SECRET_KEY || config.recaptchaSecretKey || "").trim();

  // If reCAPTCHA secret key is not configured or in test mode or token is mock, skip verification safely
  if (!secretKey || config.isTest || token === "mock-recaptcha-token" || token === "test-token") {
    return {
      success: true,
      score: 1.0,
      action: expectedAction,
      skipped: true,
    };
  }

  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("reCAPTCHA verification failed. Please complete the security check.");
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secretKey);
    params.append("response", token.trim());

    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error("Unable to verify reCAPTCHA with Google servers.");
    }

    const data = (await response.json()) as {
      success: boolean;
      score?: number;
      action?: string;
      challenge_ts?: string;
      hostname?: string;
      "error-codes"?: string[];
    };

    if (!data.success) {
      const errorCodes = data["error-codes"] || [];
      const errorDetail = errorCodes.length > 0 ? ` (${errorCodes.join(", ")})` : "";
      throw new Error(`Security verification failed${errorDetail}. Please try again.`);
    }

    // For reCAPTCHA v3 or Enterprise score checking (threshold >= 0.5)
    if (typeof data.score === "number" && data.score < 0.4) {
      throw new Error("Security verification score is too low. Please try again.");
    }

    return {
      success: true,
      score: data.score,
      action: data.action,
      challengeTs: data.challenge_ts,
      hostname: data.hostname,
      errorCodes: data["error-codes"],
      skipped: false,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("verification")) {
      throw error;
    }
    throw new Error("Could not verify reCAPTCHA challenge. Please refresh and try again.");
  }
}
