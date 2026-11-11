import { redirect } from "next/navigation";
import { getCurrentUser, homeFor } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(homeFor(user.role));

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Policy Administration</h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">
          Sign in as a broker or a policyholder. Demo logins are in the README.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
