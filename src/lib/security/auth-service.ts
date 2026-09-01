import "server-only";
import bcrypt from "bcryptjs";
import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { hmac, randomId, safeEqual } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loginSchema, signupSchema } from "@/lib/validate";
import type { OperationsData, SessionUser, UserProfile } from "@/types/site";

type CustomerIdentity = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  instagram: string;
};

export function repairOperationsCustomer(
  operations: OperationsData,
  identity: CustomerIdentity,
  profileRole: SessionUser["role"],
  profileCreated: boolean,
  now = new Date().toISOString(),
) {
  const email = identity.email.toLowerCase();
  const conflicting = operations.users.find((item) => item.email.toLowerCase() === email && item.id !== identity.id);
  if (conflicting) throw new Error("CUSTOMER_IDENTITY_CONFLICT");
  const current = operations.users.find((item) => item.id === identity.id);
  let repaired = false;
  if (current) {
    const next = {
      firstName: identity.firstName,
      lastName: identity.lastName,
      email,
      phone: identity.phone,
      instagram: identity.instagram,
    };
    repaired = Object.entries(next).some(([key, value]) => current[key as keyof typeof next] !== value);
    if (repaired) Object.assign(current, next, { updatedAt: now });
  } else {
    operations.users.push({
      id: identity.id, firstName: identity.firstName, lastName: identity.lastName, email,
      phone: identity.phone, instagram: identity.instagram, role: profileRole, tags: [], internalNotes: "",
      createdAt: now, updatedAt: now,
    });
    repaired = true;
  }
  if (repaired && !operations.auditLogs.some((item) => item.action === "customer.identity_repaired" && item.entityId === identity.id)) {
    operations.auditLogs.push({
      id: randomId("audit"), actorId: identity.id, actorEmail: email, action: "customer.identity_repaired",
      entityType: "user", entityId: identity.id, metadata: { profileCreated }, createdAt: now,
    });
  }
  return operations.users.find((item) => item.id === identity.id)!;
}

async function repairSupabaseCustomer(identity: CustomerIdentity): Promise<SessionUser> {
  const admin = createSupabaseAdminClient();
  const { data: existingProfile, error: profileReadError } = await admin.from("profiles")
    .select("id,email,first_name,last_name,phone,instagram,role")
    .eq("id", identity.id)
    .maybeSingle();
  if (profileReadError) throw new Error("CUSTOMER_REPAIR_UNAVAILABLE");

  const profileValues = {
    email: identity.email.toLowerCase(),
    first_name: identity.firstName || existingProfile?.first_name || "",
    last_name: identity.lastName || existingProfile?.last_name || "",
    phone: identity.phone || existingProfile?.phone || "",
    instagram: identity.instagram || existingProfile?.instagram || "",
  };
  const role = (existingProfile?.role || "customer") as SessionUser["role"];
  const profileChanged = !existingProfile
    || existingProfile.email !== profileValues.email
    || existingProfile.first_name !== profileValues.first_name
    || existingProfile.last_name !== profileValues.last_name
    || existingProfile.phone !== profileValues.phone
    || existingProfile.instagram !== profileValues.instagram;

  if (profileChanged) {
    const { error } = await admin.from("profiles").upsert({
      id: identity.id,
      ...profileValues,
      role,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw new Error("CUSTOMER_REPAIR_UNAVAILABLE");
  }

  const now = new Date().toISOString();
  await mutateOperationsData((ops) => repairOperationsCustomer(ops, {
    ...identity,
    email: profileValues.email,
    firstName: profileValues.first_name,
    lastName: profileValues.last_name,
    phone: profileValues.phone,
    instagram: profileValues.instagram,
  }, role, !existingProfile, now));

  return {
    id: identity.id,
    firstName: profileValues.first_name,
    lastName: profileValues.last_name,
    email: profileValues.email,
    role,
  };
}

export async function repairAuthenticatedCustomer(
  suppliedClient?: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  if (config.dataProvider !== "supabase") return null;
  const client = suppliedClient || await createSupabaseServerClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user?.email) throw new Error("AUTH_REQUIRED");
  return repairSupabaseCustomer({
    id: user.id,
    email: user.email,
    firstName: String(user.user_metadata?.first_name || ""),
    lastName: String(user.user_metadata?.last_name || ""),
    phone: String(user.user_metadata?.phone || ""),
    instagram: String(user.user_metadata?.instagram || ""),
  });
}

export async function registerCustomer(input: unknown): Promise<{ user: SessionUser; requiresEmailConfirmation: boolean }> {
  const values = signupSchema.parse(input);
  if (config.dataProvider === "supabase") {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.signUp({
      email: values.email,
      password: values.password,
      options: { data: { first_name: values.firstName, last_name: values.lastName, phone: values.phone, instagram: values.instagram || "" } }
    });
    if (error || !data.user) throw new Error("SIGNUP_FAILED");
    const repaired = await repairSupabaseCustomer({
      id: data.user.id,
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      phone: values.phone,
      instagram: values.instagram || "",
    });
    return {
      user: repaired,
      requiresEmailConfirmation: !data.session
    };
  }
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(values.password, 12);
  const user = await mutateOperationsData((ops) => {
    if (ops.users.some((user) => user.email.toLowerCase() === values.email)) throw new Error("SIGNUP_FAILED");
    const user: UserProfile = {
      id: randomId("usr"), firstName: values.firstName, lastName: values.lastName, email: values.email,
      phone: values.phone, instagram: values.instagram || "", passwordHash, role: "customer", tags: [], internalNotes: "", createdAt: now, updatedAt: now
    };
    ops.users.push(user);
    ops.auditLogs.push({ id: randomId("audit"), actorId: user.id, actorEmail: user.email, action: "customer.signup", entityType: "user", entityId: user.id, metadata: {}, createdAt: now });
    return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role };
  });
  return { user, requiresEmailConfirmation: false };
}

export async function loginCustomer(input: unknown): Promise<SessionUser> {
  const values = loginSchema.parse(input);
  if (config.dataProvider === "supabase") {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.signInWithPassword(values);
    if (error || !data.user?.email) throw new Error("Incorrect email or password.");
    return repairSupabaseCustomer({
      id: data.user.id,
      email: data.user.email,
      firstName: String(data.user.user_metadata?.first_name || ""),
      lastName: String(data.user.user_metadata?.last_name || ""),
      phone: String(data.user.user_metadata?.phone || ""),
      instagram: String(data.user.user_metadata?.instagram || ""),
    });
  }
  const ops = await readOperationsData();
  const user = ops.users.find((item) => item.email.toLowerCase() === values.email);
  if (!user?.passwordHash || !(await bcrypt.compare(values.password, user.passwordHash))) throw new Error("Incorrect email or password.");
  return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role };
}

export async function localAdminLogin(input: unknown): Promise<SessionUser> {
  if (process.env.NODE_ENV === "production" && (!process.env.ADMIN_PASSWORD || !process.env.AUTH_SECRET)) {
    throw new Error("Local administrator credentials are not configured.");
  }
  const values = loginSchema.parse(input);
  const emailMatches = safeEqual(hmac(values.email, config.authSecret), hmac(config.adminEmail, config.authSecret));
  const passwordMatches = safeEqual(hmac(values.password, config.authSecret), hmac(config.adminPassword, config.authSecret));
  if (!emailMatches || !passwordMatches) throw new Error("Incorrect administrator credentials.");
  return { id: "local-admin", firstName: "Skie", lastName: "Admin", email: config.adminEmail, role: "super_admin" };
}

export async function getUserProfile(userId: string) {
  if (userId === "local-admin") return null;
  const ops = await readOperationsData();
  return ops.users.find((user) => user.id === userId) || null;
}
