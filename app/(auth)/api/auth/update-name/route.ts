import { auth } from "@/app/(auth)/auth";
import { updateUserName } from "@/lib/db/queries";


export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { name } = await req.json();

  await updateUserName({userId:session.user.id, newName:name})

  return new Response("Name updated");
}