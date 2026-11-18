import { redirect } from "next/navigation";
import { localePath, setLocale } from "@/lib/locale";

// Launch city. Later the root becomes a city picker.
export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  redirect(localePath("/indore", setLocale((await params).locale)));
}
