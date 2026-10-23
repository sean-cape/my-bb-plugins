# Good and Bad Tests

Examples use Go with `testify/require` for assertions — `require` fails the test immediately on a mismatch, which is what you want for the single logical assertion each test is built around.

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```go
// GOOD: Tests observable behavior
func TestUserCanCheckoutWithValidCart(t *testing.T) {
	cart := NewCart()
	cart.Add(product)

	result, err := Checkout(cart, paymentMethod)

	require.NoError(t, err)
	require.Equal(t, StatusConfirmed, result.Status)
}
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```go
// BAD: Tests implementation details
func TestCheckoutCallsPaymentServiceProcess(t *testing.T) {
	mockPayment := new(MockPaymentService)
	mockPayment.On("Process", cart.Total).Return(nil)

	Checkout(cart, mockPayment)

	mockPayment.AssertCalled(t, "Process", cart.Total)
}
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```go
// BAD: Bypasses interface to verify
func TestCreateUserSavesToDatabase(t *testing.T) {
	CreateUser(User{Name: "Alice"})

	var name string
	err := db.QueryRow("SELECT name FROM users WHERE name = $1", "Alice").Scan(&name)

	require.NoError(t, err)
	require.Equal(t, "Alice", name)
}

// GOOD: Verifies through interface
func TestCreateUserMakesUserRetrievable(t *testing.T) {
	user, err := CreateUser(User{Name: "Alice"})
	require.NoError(t, err)

	retrieved, err := GetUser(user.ID)
	require.NoError(t, err)
	require.Equal(t, "Alice", retrieved.Name)
}
```

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```go
// BAD: Expected value is recomputed the way the code computes it
func TestCalculateTotalSumsLineItems(t *testing.T) {
	items := []LineItem{{Price: 10}, {Price: 5}}

	expected := 0
	for _, i := range items {
		expected += i.Price
	}

	require.Equal(t, expected, CalculateTotal(items))
}

// GOOD: Expected value is an independent, known literal
func TestCalculateTotalSumsLineItems(t *testing.T) {
	require.Equal(t, 15, CalculateTotal([]LineItem{{Price: 10}, {Price: 5}}))
}
```
