describe('marketplace guest route guards', () => {
  beforeEach(() => {
    cy.clearAllCookies();
    cy.clearAllLocalStorage();
    cy.clearAllSessionStorage();
  });

  afterEach(() => {
    cy.clearAllCookies();
    cy.clearAllLocalStorage();
    cy.clearAllSessionStorage();
  });

  it('redirects an anonymous cart visitor to the catalog with one sign-in dialog', () => {
    cy.visit('/marketplace/cart');
    cy.location('pathname').should('eq', '/marketplace');
    cy.get('[role="dialog"]:visible')
      .should('have.length', 1)
      .within(() => {
        cy.contains('h2', 'Join Pubky').should('be.visible');
      });
    cy.contains('button', 'Place sandbox order').should('not.exist');
    cy.window().then((window) => {
      expect(window.sessionStorage.getItem('pubky.routeGuard.returnTo')).to.eq('/marketplace/cart');
    });
    cy.get('[data-testid="dialog-close"]').click();
    cy.get('[role="dialog"]:visible').should('not.exist');
    cy.window().then((window) => {
      window.sessionStorage.removeItem('pubky.routeGuard.returnTo');
    });
  });

  it('redirects an anonymous seller visitor to the catalog with one sign-in dialog', () => {
    cy.visit('/marketplace/sell');
    cy.location('pathname').should('eq', '/marketplace');
    cy.get('[role="dialog"]:visible')
      .should('have.length', 1)
      .within(() => {
        cy.contains('h2', 'Join Pubky').should('be.visible');
      });
    cy.contains('button', 'Publish listing').should('not.exist');
    cy.get('[data-surface="seller-studio"]').should('not.exist');
    cy.window().then((window) => {
      expect(window.sessionStorage.getItem('pubky.routeGuard.returnTo')).to.eq('/marketplace/sell');
    });
    cy.get('[data-testid="dialog-close"]').click();
    cy.get('[role="dialog"]:visible').should('not.exist');
    cy.window().then((window) => {
      window.sessionStorage.removeItem('pubky.routeGuard.returnTo');
    });
  });
});
