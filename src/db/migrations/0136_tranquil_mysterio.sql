ALTER TABLE "almanac_duplicate_dismissals" DROP CONSTRAINT "almanac_duplicate_dismissals_pair_check";--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_pair_check" CHECK (
            ("almanac_duplicate_dismissals"."kind" = 'person' and "almanac_duplicate_dismissals"."left_person_id" is not null and "almanac_duplicate_dismissals"."right_person_id" is not null
                and "almanac_duplicate_dismissals"."left_person_id" collate "C" < "almanac_duplicate_dismissals"."right_person_id" collate "C" and "almanac_duplicate_dismissals"."left_entity_id" is null and "almanac_duplicate_dismissals"."right_entity_id" is null)
            or ("almanac_duplicate_dismissals"."kind" = 'entity' and "almanac_duplicate_dismissals"."left_entity_id" is not null and "almanac_duplicate_dismissals"."right_entity_id" is not null
                and "almanac_duplicate_dismissals"."left_entity_id" collate "C" < "almanac_duplicate_dismissals"."right_entity_id" collate "C" and "almanac_duplicate_dismissals"."left_person_id" is null and "almanac_duplicate_dismissals"."right_person_id" is null)
        );