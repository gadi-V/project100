import { redirect } from "next/navigation";

/** Direct teacher sign-up is closed; candidates apply through the careers page. */
export default function TeacherRegisterPage(): never {
  redirect("/careers");
}
