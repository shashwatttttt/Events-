"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
export function LogoutButton({admin=false}:{admin?:boolean}){const router=useRouter();const[busy,setBusy]=useState(false);async function logout(){setBusy(true);await fetch(admin?"/api/admin/logout":"/api/auth/logout",{method:"POST"});router.replace(admin?"/skie-control/login":"/");router.refresh()}return <button type="button" className="text-button" onClick={logout} disabled={busy}>{busy?"Signing out...":"Sign out"}</button>}
