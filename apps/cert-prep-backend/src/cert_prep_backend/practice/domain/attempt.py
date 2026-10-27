"""The PracticeAttempt aggregate: one graded answer to one question of a session."""

from __future__ import annotations

from dataclasses import dataclass, replace


def answer_matches_key(selected_answer: str, correct_answer: str | None) -> bool:
    """An attempt is correct when its selected answer matches the key."""

    return selected_answer == correct_answer


@dataclass(frozen=True, slots=True)
class PracticeAttempt:
    id: str
    session_id: str
    project_id: str
    question_id: str
    selected_answer: str
    is_correct: bool
    created_at: str

    def regraded(self, correct_answer: str | None) -> PracticeAttempt:
        """This attempt graded again against a key. Unchanged attempts stay the same object."""

        is_correct = answer_matches_key(self.selected_answer, correct_answer)
        if is_correct == self.is_correct:
            return self
        return replace(self, is_correct=is_correct)
