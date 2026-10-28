ALTER TABLE "meeting_agendas" DROP CONSTRAINT "meeting_agendas_time_check";--> statement-breakpoint
CREATE INDEX "agenda_points_origin_point_idx" ON "agenda_points" USING btree ("origin_point_id");--> statement-breakpoint
CREATE INDEX "agenda_suggestions_parent_point_idx" ON "agenda_suggestions" USING btree ("parent_point_id");--> statement-breakpoint
CREATE INDEX "agenda_suggestions_origin_point_idx" ON "agenda_suggestions" USING btree ("origin_point_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_task_source_idx" ON "meeting_agendas" USING btree ("task_source_item_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_snapshot_source_idx" ON "meeting_agendas" USING btree ("snapshot_source_item_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_outcome_summary_idx" ON "meeting_agendas" USING btree ("outcome_summary_id");--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_time_check" CHECK ((not "meeting_agendas"."time_set" or "meeting_agendas"."planned_start" is not null) and ("meeting_agendas"."planned_end" is null or ("meeting_agendas"."planned_start" is not null and "meeting_agendas"."planned_end" > "meeting_agendas"."planned_start")));