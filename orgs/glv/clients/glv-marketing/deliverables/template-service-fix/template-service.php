<?php
/**
 * Template Name: Service Page
 *
 * Individual GLV Marketing service sub-page.
 * Reads _glv_* post meta; falls back to the_content() if meta not set.
 * Auto-breadcrumbs from get_post_ancestors().
 */

defined( 'ABSPATH' ) || exit;

get_header();

$post_id   = get_the_ID();
$ancestors = array_reverse( (array) get_post_ancestors( $post_id ) );

$headline   = get_post_meta( $post_id, '_glv_headline', true );
$subheading = get_post_meta( $post_id, '_glv_subheading', true );
$body       = get_post_meta( $post_id, '_glv_body', true );
$cta_label  = get_post_meta( $post_id, '_glv_cta_label', true );
$cta_url    = get_post_meta( $post_id, '_glv_cta_url', true );
?>

<?php if ( ! empty( $ancestors ) ) : ?>
<nav class="glv-breadcrumbs" aria-label="Breadcrumb">
	<ol>
		<li><a href="<?php echo esc_url( home_url( '/' ) ); ?>">Home</a></li>
		<?php foreach ( $ancestors as $ancestor_id ) : ?>
			<li>
				<a href="<?php echo esc_url( get_permalink( $ancestor_id ) ); ?>">
					<?php echo esc_html( get_the_title( $ancestor_id ) ); ?>
				</a>
			</li>
		<?php endforeach; ?>
		<li aria-current="page"><?php the_title(); ?></li>
	</ol>
</nav>
<?php endif; ?>

<main id="glv-service-main" class="glv-service-page">

	<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>

	<section class="glv-service-hero">
		<h1 class="glv-service-hero__title">
			<?php echo $headline ? esc_html( $headline ) : get_the_title(); ?>
		</h1>
		<?php if ( $subheading ) : ?>
			<p class="glv-service-hero__sub"><?php echo esc_html( $subheading ); ?></p>
		<?php endif; ?>
		<?php if ( $cta_label && $cta_url ) : ?>
			<a href="<?php echo esc_url( $cta_url ); ?>" class="glv-btn glv-btn--primary">
				<?php echo esc_html( $cta_label ); ?>
			</a>
		<?php endif; ?>
	</section>

	<section class="glv-service-content">
		<?php if ( $body ) : ?>
			<?php echo wp_kses_post( $body ); ?>
		<?php else : ?>
			<?php the_content(); ?>
		<?php endif; ?>
	</section>

	<?php endwhile; endif; ?>

</main>

<?php get_footer(); ?>
