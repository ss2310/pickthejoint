import { redirect } from "next/navigation";

// Launch city. Later the root becomes a city picker.
export default function Home() {
  redirect("/indore");
}
