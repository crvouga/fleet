@local @posix
Feature: Hard reinstall an existing NixOS fleet node safely
  # OS disks and kexec are stand-ins. Real CLI, wizard, helper, ISO extraction,
  # confirmation and admission locking execute unchanged. The installer never
  # chooses a role: it installs base and Fleet assigns the role afterwards.
  Scenario Outline: Explicitly replace an existing node
    Given I open an idle existing NixOS "<role>" node
    When I review a hard reinstall
    Then the review explicitly warns that the existing installation will be replaced
    When I confirm the erase and install
    Then the verified installer is handed off without a role
    And job admission was closed before handing off when the node runs jobs

    Examples:
      | role    |
      | ci      |
      | devbox  |

  Scenario: The normal command preserves an existing healthy installation
    Given I open an idle existing NixOS "ci" node
    When I run the normal install command
    Then it reports the existing installation without a boot handoff

  Scenario: The explicit CLI flag permits a hard reinstall
    Given I open an idle existing NixOS "ci" node
    When I explicitly confirm a CLI hard reinstall
    Then the CLI hands off to the verified installer
    And job admission was closed before handing off when the node runs jobs

  Scenario: Previewing a hard reinstall makes no changes
    Given I open an idle existing NixOS "ci" node
    When I preview a CLI hard reinstall
    Then the plan names the disk and no boot handoff occurs

  Scenario: Running Actions jobs prevent a reinstall
    Given I open a NixOS CI node with an active job
    When I review a hard reinstall
    Then the review refuses to interrupt the running job
    And no boot handoff or runner withdrawal occurred

  Scenario: A disk replacement after review is refused
    Given I open an idle existing NixOS "ci" node
    When I review a hard reinstall
    And the simulated internal disk changes identity
    And I confirm the erase and install
    Then the wizard refuses the changed internal disk
    And no boot handoff or runner withdrawal occurred

  Scenario: A failed handoff reopens job admission automatically
    Given I open an idle existing NixOS "ci" node
    When I arrange for the boot handoff to fail
    And I review a hard reinstall
    And I confirm the erase and install
    Then the failed handoff reopens job admission and exposes copyable diagnostics
    When I restore the boot handoff and retry the hard reinstall
    Then the verified installer is handed off without a role
    And no runner was withdrawn
