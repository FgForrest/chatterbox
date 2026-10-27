import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    aiUsageEvents,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    mailMessages,
    people,
    recordings,
    recordingTasks,
    storageDailySnapshots,
    taskStatusTransitions,
    transcriptCorrections,
    users,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgScopeVisible } from "@/lib/org/config";
import { sharedItemCondition } from "@/lib/sharing/shared";
import {
    calendarDay,
    isStatisticsScope,
    METRICS,
    metricIndex,
    packRanking,
    type RankingRow,
    type StatisticsData,
    type StatisticsScope,
    shiftDay,
    validateTimeZone,
} from "@/lib/statistics/data";

type AggregateRow = {
    day: number;
    metric: string;
    value: string | number;
    member: string | null;
    quantity?: number;
};
type UsageRow = {
    day: number;
    provider: string;
    model: string;
    step: number;
    jobs: number;
    cost: string;
    unpriced: number;
    mail_cost: string;
    actor: string | null;
    failed: number;
    audio_cost: string;
};

export async function statisticsScopes(): Promise<StatisticsScope[]> {
    if (!isOrgScopeVisible()) return ["mine"];
    return (await getOrgUserId())
        ? ["mine", "organization", "everyone"]
        : ["mine", "everyone"];
}

/**
 * Aggregate-only statistics for an authenticated caller. Shared self-host members may
 * read Everyone, including private rows as numbers; hosted and local mode refuse it.
 * Task history uses transitions, falling back to the last known state for legacy
 * tasks without rows. Promotion moves people/entities in place or leaves merged
 * tombstones; aliases across scopes share a target and keyed identity. Everyone
 * counts those logical entries once. Unlinked independently created records cannot
 * be deduplicated reliably. Storage uses UTC-day snapshots after their first day,
 * carrying the last observation across missed runs; earlier values are estimates.
 */
export async function loadStatistics(
    callerUserId: string,
    scope: StatisticsScope,
    timeZone: string,
    now = new Date(),
): Promise<StatisticsData> {
    if (!isStatisticsScope(scope)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Unknown statistics scope",
            400,
        );
    }
    if (scope !== "mine" && !isOrgScopeVisible()) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Organization and Everyone statistics are available only in shared self-host mode",
            403,
        );
    }
    const orgUserId = scope === "mine" ? null : await getOrgUserId();
    if (scope === "organization" && !orgUserId) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "The Organization account does not exist",
            403,
        );
    }
    const tz = validateTimeZone(timeZone);
    const start = shiftDay(calendarDay(now, tz), -364);
    const end = shiftDay(start, 365);
    const startUtc = sql`(${start}::date::timestamp at time zone ${tz} at time zone 'UTC')`;
    const endUtc = sql`(${end}::date::timestamp at time zone ${tz} at time zone 'UTC')`;
    const previousUtc = sql`((${start}::date - 365)::timestamp at time zone ${tz} at time zone 'UTC')`;
    const day = (column: SQL | AnyColumn) =>
        sql`((${column} at time zone 'UTC' at time zone ${tz})::date - ${start}::date)`;
    const clippedDay = (column: SQL | AnyColumn) =>
        sql`greatest(-1, ${day(column)})`;
    const owner = (column: AnyColumn) =>
        scope === "everyone"
            ? sql`true`
            : sql`${column} = ${scope === "organization" ? orgUserId : callerUserId}`;
    const item = (ownerColumn: AnyColumn, idColumn: AnyColumn) => {
        if (scope === "organization")
            return sharedItemCondition(orgUserId as string, idColumn);
        if (scope === "everyone" && orgUserId)
            return sql`${ownerColumn} <> ${orgUserId}`;
        return owner(ownerColumn);
    };
    const itemScope = item(chatterItems.userId, chatterItems.id);
    const taskScope = item(recordingTasks.userId, recordingTasks.itemId);
    const payerScope = owner(aiUsageEvents.payerUserId);
    const knownStep = sql`case ${aiUsageEvents.operation}
        when 'transcription' then 0 when 'learn' then 1 when 'correction' then 1
        when 'summary' then 2 when 'topics' then 3 when 'title' then 4 else 5 end`;

    let snapshotOwners: SQL;
    let firstMeasurementScope: SQL;
    switch (scope) {
        case "mine":
            snapshotOwners = sql`${users.id} = ${callerUserId}`;
            firstMeasurementScope = sql`${storageDailySnapshots.userId} = ${callerUserId}`;
            break;
        case "everyone":
            snapshotOwners = sql`${users.role} <> 'org'`;
            firstMeasurementScope = sql`exists (select 1 from ${users} where ${users.id} = ${storageDailySnapshots.userId} and ${users.role} <> 'org')`;
            break;
        default:
            snapshotOwners = sql`true`;
            firstMeasurementScope = sql`true`;
    }
    const snapshotAudio =
        scope === "organization"
            ? storageDailySnapshots.sharedAudioBytes
            : storageDailySnapshots.audioBytes;
    const snapshotMail =
        scope === "organization"
            ? storageDailySnapshots.sharedMailBytes
            : storageDailySnapshots.mailBytes;

    const statements = {
        recordingMinutes: sql`select ${day(chatterItems.occurredAt)} as day,
            case when left(${recordings.plaudFileId}, 8) = 'meeting-' then 'meeting'
                when ${recordings.deviceSn} = 'local' or left(${recordings.plaudFileId}, 9) = 'uploaded-' then 'upload' else 'plaud' end as metric,
            sum(${recordings.duration})::double precision / 60000 as value, ${recordings.userId} as member, count(*)::int as quantity
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${itemScope} and ${recordings.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${chatterItems.occurredAt} >= ${previousUtc} and ${chatterItems.occurredAt} < ${endUtc}
            group by 1, 2, 4`,
        activity: sql`select ${day(recordings.createdAt)} as day, 'recordings' as metric,
                count(*) as value, null::text as member
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${itemScope} and ${recordings.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${recordings.createdAt} >= ${startUtc} and ${recordings.createdAt} < ${endUtc} group by 1
            union all
            select ${day(mailMessages.receivedAt)}, 'mail', count(*), ${mailMessages.userId}
            from ${mailMessages} inner join ${chatterItems} on ${chatterItems.id} = ${mailMessages.id}
            where ${itemScope} and ${mailMessages.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${mailMessages.receivedAt} >= ${startUtc} and ${mailMessages.receivedAt} < ${endUtc} group by 1, 4
            union all
            select ${day(aiUsageEvents.createdAt)},
                case when ${aiUsageEvents.operation} = 'transcription' then 'transcripts'
                    when ${chatterItems.kind} = 'mail' then 'mailSummaries' else 'summaries' end,
                count(*), null::text
            from ${aiUsageEvents} inner join ${chatterItems} on ${chatterItems.id} = ${aiUsageEvents.itemId}
            where ${itemScope} and ${chatterItems.deletedAt} is null
                and ${aiUsageEvents.outcome} = 'succeeded'
                and ${aiUsageEvents.operation} in ('transcription', 'summary')
                and ${aiUsageEvents.createdAt} >= ${startUtc} and ${aiUsageEvents.createdAt} < ${endUtc} group by 1, 2`,
        tasks: sql`with scoped_tasks as (
            select ${recordingTasks}.* from ${recordingTasks} where ${taskScope}
        ), history as (
            select t.* from ${taskStatusTransitions} t join scoped_tasks r on r.id = t.task_id
        ), initial as (
            select task_id, bool_or(from_status is null) as has_creation,
                sum((to_status = 'open')::int - coalesce((from_status = 'open')::int, 0)) as open_delta
            from history group by task_id
        ), legacy as (
            select r.* from scoped_tasks r where not exists (select 1 from history t where t.task_id = r.id)
        )
        select ${clippedDay(sql`r.created_at`)} as day, 'tasksCreated' as metric,
            count(*) as value, null::text as member from scoped_tasks r where r.created_at < ${endUtc} group by 1
        union all
        select ${clippedDay(sql`t.created_at`)},
            case when t.to_status = 'done' then 'tasksDone' else 'tasksDropped' end,
            count(*), t.actor_user_id from history t
            where t.created_at < ${endUtc} and (t.to_status = 'done' or
                (t.to_status = 'dropped' and t.from_status in ('open', 'done')))
            group by 1, 2, 4
        union all
        select ${clippedDay(sql`r.status_changed_at`)},
            case when r.status = 'done' then 'tasksDone' else 'tasksDropped' end,
            count(*), r.status_changed_by_user_id from legacy r
            where r.status in ('done', 'dropped') and r.status_changed_at < ${endUtc}
                and (r.status = 'done' or r.accepted_at is not null) group by 1, 2, 4
        union all
        select ${clippedDay(sql`t.created_at`)}, 'openTasks',
            sum((t.to_status = 'open')::int - coalesce((t.from_status = 'open')::int, 0)), null::text
            from history t where t.created_at < ${endUtc} group by 1
        union all
        select ${clippedDay(sql`coalesce(r.accepted_at, r.created_at)`)}, 'openTasks', count(*), null::text
            from scoped_tasks r
            join initial i on i.task_id = r.id
            where coalesce(r.accepted_at, r.created_at) < ${endUtc} and not i.has_creation
                and (r.status = 'open')::int - i.open_delta = 1 group by 1
        union all
        select ${clippedDay(sql`coalesce(r.accepted_at, r.created_at)`)}, 'openTasks', count(*), null::text
            from legacy r where r.status <> 'proposed' and coalesce(r.accepted_at, r.created_at) < ${endUtc}
                and (r.status <> 'dropped' or r.accepted_at is not null) group by 1
        union all
        select ${clippedDay(sql`r.status_changed_at`)}, 'openTasks', -count(*), null::text
            from legacy r where r.status in ('done', 'dropped') and r.status_changed_at < ${endUtc}
                and (r.status = 'done' or r.accepted_at is not null) group by 1`,
        usage: sql`select ${day(aiUsageEvents.createdAt)} as day, ${aiUsageEvents.provider} as provider,
                ${aiUsageEvents.model} as model, ${knownStep} as step, count(*)::int as jobs,
                coalesce(sum(${aiUsageEvents.costUsd}), 0) as cost,
                count(*) filter (where ${aiUsageEvents.costUsd} is null and ${aiUsageEvents.outcome} = 'succeeded')::int as unpriced,
                coalesce(sum(${aiUsageEvents.costUsd}) filter (where coalesce(${aiUsageEvents.itemKind}, ${chatterItems.kind}) = 'mail'), 0) as mail_cost,
                ${aiUsageEvents.actorUserId} as actor,
                count(*) filter (where ${aiUsageEvents.outcome} = 'failed')::int as failed,
                coalesce(sum(${aiUsageEvents.costUsd}) filter (where coalesce(${aiUsageEvents.itemKind}, ${chatterItems.kind}) = 'audio'), 0) as audio_cost
            from ${aiUsageEvents} left join ${chatterItems} on ${chatterItems.id} = ${aiUsageEvents.itemId}
            where ${payerScope} and ${aiUsageEvents.createdAt} >= ${startUtc} and ${aiUsageEvents.createdAt} < ${endUtc}
            group by 1, 2, 3, 4, 9`,
        disk: sql`select ${clippedDay(recordings.createdAt)} as day, 'audioBytes' as metric,
                sum(${recordings.filesize}) as value, null::text as member
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${itemScope} and ${recordings.createdAt} < ${endUtc} group by 1
            union all
            select ${clippedDay(sql`least(${recordings.deletedAt}, ${recordings.audioReapedAt}, ${chatterItems.deletedAt})`)},
                'audioBytes', -sum(${recordings.filesize}), null::text
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${itemScope} and least(${recordings.deletedAt}, ${recordings.audioReapedAt}, ${chatterItems.deletedAt}) < ${endUtc} group by 1
            union all
            select ${clippedDay(mailMessages.createdAt)}, 'mailBytes', sum(${mailMessages.sizeBytes}), null::text
            from ${mailMessages} inner join ${chatterItems} on ${chatterItems.id} = ${mailMessages.id}
            where ${itemScope} and ${mailMessages.createdAt} < ${endUtc} group by 1
            union all
            select ${clippedDay(sql`least(${mailMessages.deletedAt}, ${mailMessages.rawReapedAt}, ${chatterItems.deletedAt})`)},
                'mailBytes', -sum(${mailMessages.sizeBytes}), null::text
            from ${mailMessages} inner join ${chatterItems} on ${chatterItems.id} = ${mailMessages.id}
            where ${itemScope} and least(${mailMessages.deletedAt}, ${mailMessages.rawReapedAt}, ${chatterItems.deletedAt}) < ${endUtc} group by 1`,
        snapshots: sql`with scoped_users as (
            select ${users.id} as id from ${users} where ${snapshotOwners}
        ), observations as (
            select u.id as user_id, -1 as day, s.audio, s.mail
            from scoped_users u cross join lateral (
                select ${snapshotAudio} as audio, ${snapshotMail} as mail
                from ${storageDailySnapshots}
                where ${storageDailySnapshots.userId} = u.id and ${storageDailySnapshots.day} < ${start}::date
                order by ${storageDailySnapshots.day} desc limit 1
            ) s
            union all
            select ${storageDailySnapshots.userId}, (${storageDailySnapshots.day} - ${start}::date)::int,
                ${snapshotAudio}, ${snapshotMail}
            from ${storageDailySnapshots} join scoped_users u on u.id = ${storageDailySnapshots.userId}
            where ${storageDailySnapshots.day} >= ${start}::date and ${storageDailySnapshots.day} < ${end}::date
        ), changes as (
            select day, audio - lag(audio, 1, 0::bigint) over per_user as audio,
                mail - lag(mail, 1, 0::bigint) over per_user as mail
            from observations window per_user as (partition by user_id order by day)
        )
        select day, sum(sum(audio)) over (order by day) as audio,
            sum(sum(mail)) over (order by day) as mail
        from changes group by day order by day`,
        firstMeasurement: sql`select min(${storageDailySnapshots.day})::text as day
            from ${storageDailySnapshots}
            where ${storageDailySnapshots.day} < ${end}::date and ${firstMeasurementScope}`,
        // Everyone retains promoted Organization knowledge: live records move in place, and linked aliases are deduplicated below.
        knowledge: sql`select ${clippedDay(people.createdAt)} as day, 'people' as metric, count(*) as value, null::text as member
            from ${people} where ${owner(people.userId)} and ${people.mergedIntoId} is null and ${people.createdAt} < ${endUtc} group by 1
            union all
            select ${clippedDay(knowledgeEntities.createdAt)}, case when ${knowledgeEntities.typeKey} = 'term' then 'terms' else 'entities' end,
                count(*), null::text from ${knowledgeEntities}
            where ${owner(knowledgeEntities.userId)} and ${knowledgeEntities.mergedIntoId} is null and ${knowledgeEntities.createdAt} < ${endUtc} group by 1, 2
            union all
            select ${clippedDay(sql`a.created_at`)}, 'aliases', count(*), null::text from (
                select min(${knowledgeAliases.createdAt}) as created_at from ${knowledgeAliases}
                where ${owner(knowledgeAliases.userId)}
                group by ${scope === "everyone" ? sql`null::text` : sql`${knowledgeAliases.userId}`},
                    ${knowledgeAliases.personId}, ${knowledgeAliases.entityId}, ${knowledgeAliases.kind},
                    ${knowledgeAliases.textHmac}, ${knowledgeAliases.correctionId}
            ) a where a.created_at < ${endUtc} group by 1
            union all
            select ${day(transcriptCorrections.createdAt)}, 'corrections', count(*), null::text from ${transcriptCorrections}
            where ${owner(transcriptCorrections.userId)} and ${transcriptCorrections.kind} in ('correct', 'fix')
                and ${transcriptCorrections.createdAt} >= ${startUtc} and ${transcriptCorrections.createdAt} < ${endUtc} group by 1`,
        heat: sql`select ${day(chatterItems.occurredAt)} as day,
                extract(hour from ${chatterItems.occurredAt} at time zone 'UTC' at time zone ${tz})::int as hour, count(*)::int as count
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${itemScope} and ${recordings.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${chatterItems.occurredAt} >= ${startUtc} and ${chatterItems.occurredAt} < ${endUtc} group by 1, 2`,
        latency: sql`select ${day(chatterItems.occurredAt)} as day,
                greatest(0, round(extract(epoch from (first_summary.at - coalesce(${recordings.endTime},
                    ${chatterItems.occurredAt} + ${recordings.duration} * interval '1 millisecond')))))::int as seconds,
                count(*)::int as count
            from ${recordings} inner join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            inner join lateral (select min(${aiEnhancements.createdAt}) as at from ${aiEnhancements}
                where ${aiEnhancements.itemId} = ${recordings.id} and ${aiEnhancements.userId} = ${recordings.userId}
                    and ${aiEnhancements.summary} is not null) first_summary on first_summary.at is not null
            where ${itemScope} and ${recordings.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${chatterItems.occurredAt} >= ${startUtc} and ${chatterItems.occurredAt} < ${endUtc} group by 1, 2`,
    };
    const [
        minutes,
        activity,
        tasks,
        usage,
        disk,
        knowledge,
        heat,
        latency,
        memberRows,
        snapshots,
        firstMeasurement,
    ] = await Promise.all([
        db.execute<AggregateRow>(statements.recordingMinutes),
        db.execute<AggregateRow>(statements.activity),
        db.execute<AggregateRow>(statements.tasks),
        db.execute<UsageRow>(statements.usage),
        db.execute<AggregateRow>(statements.disk),
        db.execute<AggregateRow>(statements.knowledge),
        db.execute<{ day: number; hour: number; count: number }>(
            statements.heat,
        ),
        db.execute<{ day: number; seconds: number; count: number }>(
            statements.latency,
        ),
        scope === "mine"
            ? Promise.resolve([])
            : db
                  .select({ id: users.id, name: users.name })
                  .from(users)
                  .where(sql`${users.role} <> 'org'`)
                  .orderBy(users.id),
        db.execute<{ day: number; audio: string; mail: string }>(
            statements.snapshots,
        ),
        db.execute<{ day: string | null }>(statements.firstMeasurement),
    ]);
    const data: StatisticsData = {
        scope,
        tz,
        start,
        days: 365,
        daily: METRICS.map(() => Array<number>(365).fill(0)),
        baseline: METRICS.map(() => 0),
        comparisonMinutes: Array<number>(365).fill(0),
        members: memberRows.map(({ id, name }) => [
            name?.trim() && !name.includes("@") ? name.trim() : null,
            id === callerUserId,
        ]),
        ranking: [],
        models: [],
        modelDays: [],
        heat: [],
        latency: [],
        measuredFrom: firstMeasurement[0]?.day ?? null,
    };
    const memberIndices = new Map(memberRows.map(({ id }, i) => [id, i]));
    const ranking = new Map<string, RankingRow>();
    function rank(
        dayIndex: number,
        memberId: string | null,
        field: 2 | 3 | 4 | 5,
        value: number,
    ) {
        if (dayIndex < 0 || dayIndex >= 365 || !memberId) return;
        const member = memberIndices.get(memberId);
        if (member === undefined) return;
        const key = `${dayIndex}:${member}`;
        const row = ranking.get(key) ?? [dayIndex, member, 0, 0, 0, 0];
        row[field] += value;
        ranking.set(key, row);
    }
    function add(dayIndex: number, metric: string, value: number) {
        if (dayIndex >= 0 && dayIndex < 365 && metric in metricIndex)
            data.daily[metricIndex[metric as keyof typeof metricIndex]][
                dayIndex
            ] += value;
    }
    for (const row of minutes) {
        const dayIndex = Number(row.day);
        const value = Number(row.value);
        if (dayIndex < 0 && dayIndex >= -365)
            data.comparisonMinutes[dayIndex + 365] += value;
        add(dayIndex, "minutes", value);
        add(dayIndex, "startedRecordings", Number(row.quantity ?? 0));
        add(dayIndex, row.metric, value);
        rank(dayIndex, row.member, 2, value);
    }
    const baseline = new Map<string, number>();
    for (const row of [...activity, ...tasks, ...disk, ...knowledge]) {
        const dayIndex = Number(row.day);
        const value = Number(row.value);
        if (dayIndex < 0)
            baseline.set(row.metric, (baseline.get(row.metric) ?? 0) + value);
        add(dayIndex, row.metric, value);
        if (row.metric === "mail") rank(dayIndex, row.member, 3, value);
        if (row.metric === "tasksDone") rank(dayIndex, row.member, 4, value);
    }
    const models = new Map<string, number>();
    const modelDays = new Map<string, StatisticsData["modelDays"][number]>();
    for (const row of usage) {
        const dayIndex = Number(row.day);
        const cost = Number(row.cost);
        const step = Number(row.step);
        const costMetric = [
            "transcriptionCost",
            "learnCost",
            "summaryCost",
            "topicsCost",
            "titleCost",
            "otherCost",
        ][step];
        if (costMetric) add(dayIndex, costMetric, cost);
        add(dayIndex, "mailCost", Number(row.mail_cost));
        add(dayIndex, "audioCost", Number(row.audio_cost));
        add(dayIndex, "unpriced", Number(row.unpriced));
        rank(dayIndex, row.actor, 5, cost);
        const key = JSON.stringify([row.provider, row.model]);
        let model = models.get(key);
        if (model === undefined) {
            model = data.models.length;
            models.set(key, model);
            data.models.push([row.provider, row.model]);
        }
        const dailyKey = `${dayIndex}:${model}:${step}`;
        const values = modelDays.get(dailyKey) ?? [
            dayIndex,
            model,
            step,
            0,
            0,
            0,
            0,
        ];
        values[3] += Number(row.jobs);
        values[4] += cost;
        values[5] += Number(row.unpriced);
        values[6] = (values[6] ?? 0) + Number(row.failed);
        modelDays.set(dailyKey, values);
    }
    for (const metric of [
        "openTasks",
        "audioBytes",
        "mailBytes",
        "people",
        "entities",
        "terms",
        "aliases",
    ] as const) {
        let value = baseline.get(metric) ?? 0;
        data.baseline[metricIndex[metric]] = value;
        data.daily[metricIndex[metric]] = data.daily[metricIndex[metric]].map(
            (change) => {
                value += change;
                return Math.max(0, value);
            },
        );
    }
    const priorSnapshot = snapshots.filter((row) => Number(row.day) < 0).at(-1);
    if (priorSnapshot) {
        data.baseline[metricIndex.audioBytes] = Number(priorSnapshot.audio);
        data.baseline[metricIndex.mailBytes] = Number(priorSnapshot.mail);
    }
    let snapshotIndex = 0;
    let measured: (typeof snapshots)[number] | undefined;
    for (let i = 0; i < data.days; i++) {
        while (
            snapshotIndex < snapshots.length &&
            Number(snapshots[snapshotIndex].day) <= i
        ) {
            measured = snapshots[snapshotIndex++];
        }
        if (measured) {
            data.daily[metricIndex.audioBytes][i] = Number(measured.audio);
            data.daily[metricIndex.mailBytes][i] = Number(measured.mail);
        }
    }
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    data.daily = data.daily.map((series) => series.map(round));
    data.comparisonMinutes = data.comparisonMinutes.map(round);
    data.ranking = packRanking([...ranking.values()], memberRows.length);
    data.modelDays = [...modelDays.values()].map((row) => {
        const values: StatisticsData["modelDays"][number] = [
            row[0],
            row[1],
            row[2],
            row[3],
            round(row[4]),
            row[5],
        ];
        if (row[6]) values[6] = row[6];
        return values;
    });
    data.heat = heat.map((row) => [
        Number(row.day),
        Number(row.hour),
        Number(row.count),
    ]);
    data.latency = latency.map((row) => [
        Number(row.day),
        Number(row.seconds),
        Number(row.count),
    ]);
    return data;
}
