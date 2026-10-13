import type { Person, PersonHistory, Session } from '../shared/types';
export function peopleHistory(people: Person[], sessions: Session[], input: { query?: string; personId?: string }): PersonHistory[] {
  const terms = input.query?.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
  return people.filter(person => !input.personId || person.id === input.personId).map(person => {
    const linked = sessions.filter(session => session.attendeeIds?.includes(person.id) || session.commitments?.some(commitment => commitment.personId === person.id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const commitments = linked.flatMap(session => (session.commitments ?? []).filter(commitment => commitment.personId === person.id).map(commitment => ({ ...commitment, sessionId: session.id, sessionTitle: session.title })));
    return { person, sessions: linked, commitments };
  }).filter(item => { const searchable = `${item.person.name} ${item.person.email ?? ''} ${item.person.company ?? ''} ${item.person.role ?? ''} ${item.person.notes ?? ''} ${item.sessions.map(session => `${session.title} ${session.notes}`).join(' ')} ${item.commitments.map(commitment => commitment.text).join(' ')}`.toLocaleLowerCase(); return terms.every(term => searchable.includes(term)); }).sort((a, b) => a.person.name.localeCompare(b.person.name));
}
export function explicitCommitmentOwner(text: string, people: Person[]) {
  const matches = people.filter(person => { const name = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`^\\s*(?:Owner:\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*(?::|[-–—]|will\\b|to\\b)`, 'iu').test(text); });
  return matches.length === 1 ? matches[0] : undefined;
}
