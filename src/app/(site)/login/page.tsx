import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getCurrentUser } from "@/lib/security/session";
import { safeRedirectPath } from "@/lib/security/redirects";
export const metadata = { title: "Log in" };
export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string}>}){const{next}=await searchParams;if(await getCurrentUser())redirect(safeRedirectPath(next));return <section className="auth-page"><div className="auth-orbit"/><div className="auth-panel"><p className="eyebrow"><span/>Customer access</p><h1>Log back into the night.</h1><p>Applications, unlocked allocations, orders and QR tickets live here.</p><AuthForm mode="login"/></div></section>}
