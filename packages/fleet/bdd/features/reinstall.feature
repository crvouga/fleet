@local @posix
Feature: Hard reinstall an existing NixOS fleet node safely
  # OS disks and kexec are stand-ins. Real CLI, wizard, helper, ISO extraction,
  # confirmation, runner withdrawal and admission locking execute unchanged.
  Scenario Outline: Explicitly replace an existing node of the same role
    Given I open an idle existing NixOS "<role>" node
    When I review a hard reinstall of its current role
    Then the review explicitly warns that the existing installation will be replaced
    When I confirm the erase and install
    Then the verified installer is handed off for the same role
    And active CI admission was closed before handing off

    Examples:
      | role    |
      | ci      |
      | devbox  |

  Scenario: The normal command preserves an existing healthy installation
    Given I open an idle existing NixOS "ci" node
    When I run the normal same-role install command
    Then it reports the existing installation without a boot handoff

  Scenario: The explicit CLI flag permits a same-role hard reinstall
    Given I open an idle existing NixOS "ci" node
    When I explicitly confirm a same-role CLI hard reinstall
    Then the CLI hands off to the verified installer
    And active CI admission was closed before handing off

  Scenario: Previewing a hard reinstall makes no changes
    Given I open an idle existing NixOS "ci" node
    When I preview a same-role CLI hard reinstall
    Then the plan names the disk and no boot handoff occurs

  Scenario: Running Actions jobs prevent a reinstall
    Given I open a NixOS CI node with an active job
    When I review a hard reinstall of its current role
    Then the review refuses to interrupt the running job
    And no boot handoff or runner withdrawal occurred

  Scenario: A disk replacement after review is refused
    Given I open an idle existing NixOS "ci" node
    When I review a hard reinstall of its current role
    And the simulated internal disk changes identity
    And I confirm the erase and install
    Then the wizard refuses the changed internal disk
    And no boot handoff or runner withdrawal occurred

  Scenario: A failed handoff restores the unchanged source node automatically
    Given I open an idle existing NixOS "ci" node
    When I arrange for the boot handoff to fail
    And I review a hard reinstall of its current role
    And I confirm the erase and install
    Then the failed handoff restores the CI node and exposes copyable diagnostics
    When I restore the boot handoff and retry the hard reinstall
    Then the verified installer is handed off for the same role
    And the CI runner was withdrawn once per actual attempt
