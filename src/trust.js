// What letting a member in means, said plainly: `parley approve` and `parley
// join` show it in a red box, the view in its approve dialog. `widen` names
// how to allow more from where the person reads it.
export function trustLines(name, autonomy, widen = "`parley autonomy work`") {
  return [
    `${name}'s agent will send messages that your Claude reads and acts on, also while you are away.`,
    autonomy === "work"
      ? `With autonomy "work" (yours now), it can pull, resolve conflicts, edit project files, commit and push when ${name}'s agent asks.`
      : `With autonomy "read" (yours now), it only reads and answers; ${widen} would let it change the project when asked.`,
    "Parley keeps all of it to this project and never sends your secrets, but it cannot tell a wise request from a harmful one.",
    `Only continue if you trust ${name} with this repository.`,
  ];
}
