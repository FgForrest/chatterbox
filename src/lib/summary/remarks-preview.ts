export type SummaryRemarksPreview =
    | {
          available: true;
          profileName: string;
          model: string;
          provider: string;
      }
    | {
          available: false;
          reason: "profile-unavailable" | "provider-unavailable";
          profileName?: string;
      };
