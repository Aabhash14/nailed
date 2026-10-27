import { Suspense } from "react";
import { LoginForm } from "@/components/admin/login-form";

export const metadata = { title: "Sign in" };

export default function AdminLogin() {
  // useSearchParams (the ?next= redirect target) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
