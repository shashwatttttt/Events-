import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getCurrentUser } from "@/lib/security/session";
import { safeRedirectPath } from "@/lib/security/redirects";
export const metadata = { title: "Create account" };
export default async function SignupPage({searchParams}:{searchParams:Promise<{next?:string}>}){const{next}=await searchParams;if(await getCurrentUser())redirect(safeRedirectPath(next));return <section className="auth-page"><div className="auth-orbit"/><div className="auth-panel"><p className="eyebrow"><span/>Create access</p><h1>Your Skie account starts here.</h1><p>One profile for applications, unlocked tickets, event extras and entry QR codes.</p><AuthForm mode="signup"/></div></section>}
