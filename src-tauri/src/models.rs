use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub description: String,
    pub color: String,
    pub status: String,
    pub sort_order: i64,
    pub trashed: i64,
    pub cards: Vec<Card>,
    pub tags: Vec<Tag>,
}

#[derive(Serialize, Clone)]
pub struct Card {
    pub id: String,
    pub project_id: String,
    pub text: String,
    pub icon: String,
    pub sort_order: i64,
    pub completed: i64,
    pub deleted: i64,
    pub deleted_at: Option<i64>,
    pub image: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct ProjectInput {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub status: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Deserialize)]
pub struct CardInput {
    pub id: String,
    pub project_id: String,
    pub text: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i64>,
    pub completed: Option<bool>,
    pub image: Option<String>,
}

#[derive(Deserialize)]
pub struct MigrateProject {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub cards: Option<Vec<MigrateCard>>,
}

#[derive(Deserialize)]
pub struct MigrateCard {
    pub id: String,
    pub text: Option<String>,
    pub icon: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::CardInput;

    // The P1 tray-edit bug: spreading the serialized card into save_card sends
    // `completed` as an int (0/1), but CardInput types it as Option<bool> and
    // serde_json refuses int->bool, failing the whole command. This pins the
    // contract: the old payload must be rejected, the fix's clean payload kept.
    #[test]
    fn card_input_rejects_int_completed_but_accepts_clean_payload() {
        // What TrayApp.jsx used to send (full DB row spread).
        let spread_db_row = r#"{"id":"a","project_id":"p","text":"hi","icon":"Zap",
            "sort_order":0,"completed":0,"deleted":0,"deleted_at":null,"image":null}"#;
        assert!(
            serde_json::from_str::<CardInput>(spread_db_row).is_err(),
            "int `completed` must be rejected — this is the bug that lost tray edits"
        );

        // What the fix sends (command-shaped, no `completed`).
        let clean = r#"{"id":"a","project_id":"p","text":"hi","icon":"Zap","sort_order":0}"#;
        assert!(
            serde_json::from_str::<CardInput>(clean).is_ok(),
            "clean command payload must deserialize"
        );

        // And a correctly-typed bool still works (the complete_card path).
        let with_bool = r#"{"id":"a","project_id":"p","completed":true}"#;
        assert!(serde_json::from_str::<CardInput>(with_bool).is_ok());
    }
}
