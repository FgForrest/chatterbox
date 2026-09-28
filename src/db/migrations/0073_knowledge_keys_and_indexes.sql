ALTER TABLE "knowledge_vectors" DROP CONSTRAINT "knowledge_vectors_item_unique";--> statement-breakpoint
CREATE INDEX "knowledge_aliases_created_by_user_id_idx" ON "knowledge_aliases" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_entities_created_by_user_id_idx" ON "knowledge_entities" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_entities_type_key_idx" ON "knowledge_entities" USING btree ("type_key");--> statement-breakpoint
CREATE INDEX "knowledge_entity_types_created_by_user_id_idx" ON "knowledge_entity_types" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_entity_types_adopted_as_key_idx" ON "knowledge_entity_types" USING btree ("adopted_as_key");--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_confirmed_by_user_id_idx" ON "knowledge_fact_evidence" USING btree ("confirmed_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_created_by_user_id_idx" ON "knowledge_facts" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_relation_key_idx" ON "knowledge_facts" USING btree ("relation_key");--> statement-breakpoint
CREATE INDEX "knowledge_facts_subject_key_idx" ON "knowledge_facts" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "knowledge_facts_object_key_idx" ON "knowledge_facts" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "knowledge_relation_types_created_by_user_id_idx" ON "knowledge_relation_types" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_relation_types_adopted_as_key_idx" ON "knowledge_relation_types" USING btree ("adopted_as_key");--> statement-breakpoint
CREATE INDEX "knowledge_vectors_entity_id_idx" ON "knowledge_vectors" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "transcript_corrections_created_by_user_id_idx" ON "transcript_corrections" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "knowledge_vectors" ADD CONSTRAINT "knowledge_vectors_item_unique" UNIQUE NULLS NOT DISTINCT("user_id","entity_id","fact_id","vector_generation");