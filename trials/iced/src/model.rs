use serde::Deserialize;
use serde_json::Value;

// These are the existing TypeScript core's JSON boundary, not a second parser.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Value,
    pub watched: Vec<String>,
    pub threads: Vec<Thread>,
    pub recruitments: Vec<Recruitment>,
    pub errors: Vec<String>,
    pub notices: Vec<String>,
    pub refreshing: bool,
    pub updated_at: Option<u64>,
    pub notification_available: bool,
}

#[derive(Debug, Deserialize)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recruitment {
    pub number: u64,
    pub name: String,
    pub id: String,
    pub watchoi: String,
    pub body: String,
    pub posted_at: u64,
    pub effective_posted_at: u64,
    pub deadline_at: Option<u64>,
    pub room_ids: Vec<String>,
    pub thread_id: String,
    pub closed: bool,
}

#[cfg(test)]
mod tests {
    use super::Recruitment;

    #[test]
    fn recruitment_accepts_optional_camel_case_deadline() {
        let mut value = serde_json::json!({
            "number": 1,
            "name": "募集者",
            "id": "synthetic",
            "watchoi": "",
            "body": "友人戦 12345",
            "postedAt": 1000,
            "effectivePostedAt": 1000,
            "roomIds": ["12345"],
            "threadId": "synthetic-thread",
            "closed": false
        });
        for (deadline, expected) in [
            (None, None),
            (Some(serde_json::Value::Null), None),
            (Some(serde_json::json!(60000)), Some(60000)),
        ] {
            if let Some(deadline) = deadline {
                value["deadlineAt"] = deadline;
            }
            let item: Recruitment = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(item.deadline_at, expected);
        }
    }
}
