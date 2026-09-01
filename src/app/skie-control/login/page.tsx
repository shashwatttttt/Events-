import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { isAdmin } from "@/lib/auth";
export const dynamic="force-dynamic";
export const metadata={title:"Admin login"};
export default async function AdminLoginPage(){if(await isAdmin())redirect("/skie-control");return <><a className="skip-link" href="#admin-login-main">Skip to admin login</a><main className="admin-login-page" id="admin-login-main" tabIndex={-1}><div className="admin-login-orbit" aria-hidden="true"/><section><div className="admin-wordmark admin-wordmark-login"><strong>SKIE</strong><small>CONTROL</small></div><p className="eyebrow"><span aria-hidden="true"/>Restricted system</p><h1>Control stays backstage.</h1><p>The URL is hidden from public navigation, but authentication and server-side role checks provide the actual protection.</p><AdminLoginForm/></section></main></>}
