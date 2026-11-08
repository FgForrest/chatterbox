import { agendaTextRoutes } from "@/lib/meetings/text-route";

const routes = agendaTextRoutes(true);
export const GET = routes.GET;
export const POST = routes.POST;
