/** Same named object identity as the retired SDK's getContainer helper. */
export function getContainer<Id, Stub>(
  binding: { idFromName(name: string): Id; get(id: Id): Stub },
  name: string,
): Stub {
  return binding.get(binding.idFromName(name));
}
