// Scripted responses for the toy todo app, keyed on the last user turn.
// Used by the end-to-end test and by the standalone mock server so the example
// in examples/todo-app can be run by someone with no model at all.
//
// A second, deliberately worse script models a challenger that regresses in the
// two ways that matter: it guesses an id instead of looking it up, and it leaks
// its planning voice into the visible answer.

export const TODO_APP_SCRIPT = [
  { match: /morning|hey/i, content: 'Morning. What do you want to knock out first?' },
  { match: /twelve times twelve/i, content: '144.' },
  {
    match: /add milk/i,
    content: 'Added.',
    toolCalls: [{ name: 'add_todo', arguments: { title: 'Buy milk' } }],
  },
  {
    match: /what's left on my list/i,
    content: '',
    toolCalls: [{ name: 'list_todos', arguments: { filter: 'open' } }],
  },
  {
    match: /organise a todo list/i,
    content: 'Keep one list, not four. Put a date on anything that actually has one, and let everything else sit undated rather than inventing deadlines you will ignore. Once a week, delete instead of reschedule.',
  },
  {
    match: /mark the milk one done/i,
    content: '',
    think: 'I do not have an id for that item, so I must list first.',
    toolCalls: [{ name: 'list_todos', arguments: { filter: 'open' } }],
  },
  {
    match: /the second one is done/i,
    content: 'Done.',
    toolCalls: [{ name: 'complete_todo', arguments: { id: 52 } }],
  },
  {
    match: /hardware store open/i,
    content: '',
    toolCalls: [{ name: 'search_web', arguments: { query: 'hardware store hours today' } }],
  },
  {
    match: /put that in a card/i,
    content: 'Here it is.\n<card title="This week">Mon — filed taxes\nWed — fixed the gate\nThu — called the bank</card>',
  },
  {
    match: /something about the car/i,
    content: '',
    toolCalls: [{ name: 'list_todos', arguments: { filter: 'all' } }],
  },
  { match: /.*/, content: 'Okay.' },
];

export const TODO_APP_SCRIPT_WEAKER = TODO_APP_SCRIPT.map((entry) => {
  if (String(entry.match).includes('mark the milk one done')) {
    // Guesses an id it was never given: the exact failure `complete-needs-lookup` exists to catch.
    return { ...entry, think: undefined, content: 'Marked it done.', toolCalls: [{ name: 'complete_todo', arguments: { id: 41 } }] };
  }
  if (String(entry.match).includes('twelve times twelve')) {
    // Planning voice in the visible channel, untagged: a structural failure.
    return { ...entry, content: 'Okay, the user wants twelve times twelve, so I should just answer: 144.' };
  }
  if (String(entry.match).includes('morning')) {
    return { ...entry, content: 'Good morning to you! I hope your day is off to a wonderful start. There is a great deal we could do together today, so let me know whenever you are ready to begin working through anything at all on your list.' };
  }
  return entry;
});
