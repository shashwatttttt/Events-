import { requirePageUser } from "@/lib/auth";
export const dynamic="force-dynamic";
export const metadata={title:"My account"};
export default async function AccountLayout({children}:{children:React.ReactNode}){await requirePageUser("/account");return children}
