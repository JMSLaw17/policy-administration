import { BackLink, Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { CustomerForm } from "./customer-form";

export const metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  await requireUser("BROKER");
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink href="/broker">Customers</BackLink>
      <Card
        title="New customer"
        description="Use fictional details. A policyholder login is created with this email and the demo password."
      >
        <CustomerForm />
      </Card>
    </div>
  );
}
