import { notFound } from "next/navigation";
import { TestCheckout } from "@/components/TestCheckout";
import { requirePageUser } from "@/lib/auth";
import { isEffectiveTestMode } from "@/lib/mode";
import { readOperationsData } from "@/lib/data/documents";
export const dynamic="force-dynamic";
export default async function TestCheckoutPage({searchParams}:{searchParams:Promise<{order?:string}>}){if(!(await isEffectiveTestMode()))notFound();const{order:orderId}=await searchParams;const next=orderId?`/checkout/test?order=${encodeURIComponent(orderId)}`:"/checkout/test";const user=await requirePageUser(next,["customer"]);const ops=await readOperationsData();const order=ops.orders.find(item=>item.id===orderId&&item.userId===user.id&&item.status==='pending');if(!order)notFound();return <section className="checkout-page"><div className="shell narrow-shell"><TestCheckout order={order}/></div></section>}
